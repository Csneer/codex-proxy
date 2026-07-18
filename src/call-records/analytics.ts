import type { CallOverview, CallRange, CallRangePreset, CallContextSummary } from "./types.js";
import { CallRecordStore } from "./store.js";

function validZone(timezone: string): void {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw new Error("Invalid timezone"); }
}

function localDateParts(timezone: string, value: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const result = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { year: Number(result.year), month: Number(result.month), day: Number(result.day) };
}

function offsetMinutes(timezone: string, value: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(value).find((item) => item.type === "timeZoneName")?.value ?? "GMT";
  const match = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "+" ? minutes : -minutes;
}

function midnightUtc(timezone: string, parts: { year: number; month: number; day: number }): Date {
  const guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return new Date(guess.getTime() - offsetMinutes(timezone, guess) * 60_000);
}

function bucketSizeMs(preset: CallRangePreset): number { return preset === "7d" ? 86_400_000 : 3_600_000; }

function localBucketKey(value: string, timezone: string, preset: CallRangePreset): string {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", ...(preset === "7d" ? {} : { hour: "2-digit", hourCycle: "h23" }) }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return preset === "7d" ? `${values.year}-${values.month}-${values.day}` : `${values.year}-${values.month}-${values.day}T${values.hour}`;
}

function rangeBounds(preset: CallRangePreset, timezone: string, now: Date): { from: Date; to: Date } {
  const to = new Date(now);
  if (preset === "24h") return { from: new Date(to.getTime() - 86400000), to };
  if (preset === "7d") return { from: new Date(to.getTime() - 7 * 86400000), to };
  const today = localDateParts(timezone, to);
  const from = midnightUtc(timezone, today);
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const nextParts = localDateParts(timezone, next);
  const nextMidnight = midnightUtc(timezone, nextParts);
  return { from, to: nextMidnight.getTime() > to.getTime() ? to : nextMidnight };
}

export function resolveCallRange(input: { range?: CallRangePreset; timezone?: string; now?: Date }): CallRange {
  const preset = input.range ?? "today";
  const timezone = input.timezone ?? "UTC";
  validZone(timezone);
  const now = input.now ?? new Date();
  const { from, to } = rangeBounds(preset, timezone, now);
  const duration = to.getTime() - from.getTime();
  return { preset, timezone, from: from.toISOString(), to: to.toISOString(), previousFrom: new Date(from.getTime() - duration).toISOString(), previousTo: from.toISOString() };
}

export class CallRecordAnalytics {
  constructor(private readonly store: CallRecordStore, private readonly now: () => Date = () => new Date()) {}
  getOverview(input: { range?: CallRangePreset; timezone?: string }): CallOverview {
    const generatedAt = this.now();
    const range = resolveCallRange({ ...input, now: generatedAt });
    const rows = this.store.queryAnalytics<any>(`SELECT COUNT(*) count, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cached_tokens),0) cached_tokens, MAX(completed_at) last_completed_at FROM call_records WHERE completed_at >= @from AND completed_at < @to`, { from: range.from, to: range.to });
    const current = rows[0] ?? {};
    const previous = this.store.queryAnalytics<any>(`SELECT COUNT(*) count FROM call_records WHERE completed_at >= @from AND completed_at < @to`, { from: range.previousFrom, to: range.previousTo })[0] ?? {};
    const models = this.store.queryAnalytics<any>(`SELECT model, COUNT(*) count FROM call_records WHERE completed_at >= @from AND completed_at < @to GROUP BY model ORDER BY count DESC`, { from: range.from, to: range.to }).map((r) => ({ model: r.model, count: Number(r.count), share: Number(current.count) ? Number(r.count) / Number(current.count) : 0 }));
    const protocols = this.store.queryAnalytics<any>(`SELECT protocol, COUNT(*) count FROM call_records WHERE completed_at >= @from AND completed_at < @to GROUP BY protocol ORDER BY count DESC`, { from: range.from, to: range.to }).map((r) => ({ protocol: r.protocol, count: Number(r.count), share: Number(current.count) ? Number(r.count) / Number(current.count) : 0 }));
    const contexts = this.store.listContexts({ from: range.from, to: range.to, limit: 20 }).contexts as CallContextSummary[];
    const state = this.store.getState();
    const inputTokens = Number(current.input_tokens ?? 0);
    const bucketRows = this.store.queryAnalytics<{ completed_at: string }>(`SELECT completed_at FROM call_records WHERE completed_at >= @from AND completed_at < @to ORDER BY completed_at`, { from: range.from, to: range.to });
    const bucketCounts = new Map<string, number>();
    for (const row of bucketRows) { const key = localBucketKey(row.completed_at, range.timezone, range.preset); bucketCounts.set(key, (bucketCounts.get(key) ?? 0) + 1); }
    const step = bucketSizeMs(range.preset);
    const series: Array<{ bucketStart: string; success: number }> = [];
    for (let cursor = new Date(range.from); cursor < new Date(range.to); cursor = new Date(cursor.getTime() + step)) {
      series.push({ bucketStart: cursor.toISOString(), success: bucketCounts.get(localBucketKey(cursor.toISOString(), range.timezone, range.preset)) ?? 0 });
    }
    return { range: { preset: range.preset, timezone: range.timezone, from: range.from, to: range.to }, generatedAt: generatedAt.toISOString(), success: { count: Number(current.count ?? 0), previousCount: Number(previous.count ?? 0), lastCompletedAt: current.last_completed_at ?? null }, usage: { inputTokens, outputTokens: Number(current.output_tokens ?? 0), cachedTokens: Number(current.cached_tokens ?? 0), cacheRatio: inputTokens ? Number(current.cached_tokens ?? 0) / inputTokens : 0 }, storage: { permanentBytes: state.databaseBytes, rawBytes: 0, semanticLogicalBytes: 0, rawLogicalBytes: 0, indexBytes: 0, walBytes: state.walBytes, totalBytes: state.totalBytes, measurement: "sqlite-pages-and-logical-sums" }, outcomes: { failure: 0, interrupted: 0, retry: 0 }, series, models, protocols, contexts, sections: {} };
  }
}
