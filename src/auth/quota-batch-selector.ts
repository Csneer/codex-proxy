import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { getDataDir } from "../paths.js";
import { getRateLimitIdForModel } from "./quota-utils.js";
import type { AccountEntry, CodexQuotaWindow } from "./types.js";

interface QuotaMeter {
  key: string;
  usedPercent: number;
  windowSeconds: number | null;
  resetAt: number | null;
}

interface QuotaBucket {
  key: string;
  windowSeconds: number | null;
  bucket: number;
}

const MAX_TRACKED_METERS = 4;

export interface QuotaBatchCheckpoint {
  version: 3;
  strategy: "quota_batch";
  batchPercent: number;
  currentEntryId: string;
  meters: QuotaBucket[];
}

export interface QuotaBatchStateStore {
  load(): unknown;
  save(state: QuotaBatchCheckpoint): void;
  clear(): void;
}

interface SelectionOptions {
  model?: string;
  nowMs?: number;
  maxQuotaAgeMs?: number;
}

export type QuotaMeterKind = "secondary" | "primary";

export interface EffectiveQuotaMeter {
  kind: QuotaMeterKind;
  usedPercent: number;
  resetAt: number | null;
  windowSeconds: number | null;
}

/**
 * Return the actual quota window used for batching by this account.
 *
 * Window duration is the authority: a 5-hour, 7-day, or 30-day window is not
 * assumed by code or plan name. When several windows are published, use the
 * shortest applicable one because it is the earliest reliable consumption
 * signal. Model-specific buckets take precedence when the request has one.
 */
export function effectiveQuotaMeter(entry: AccountEntry): EffectiveQuotaMeter | null {
  const meter = quotaMeters(entry, {}, false)[0];
  if (!meter) return null;
  return {
    kind: meter.key.endsWith(":secondary") || meter.key === "secondary" ? "secondary" : "primary",
    usedPercent: meter.usedPercent,
    resetAt: meter.resetAt,
    windowSeconds: meter.windowSeconds,
  };
}

/** Use one actual applicable window, without assuming a plan or duration. */
function quotaMeters(entry: AccountEntry, options: SelectionOptions, requireFresh = true): QuotaMeter[] {
  const quota = entry.cachedQuota;
  if (!quota) return [];
  const meters: QuotaMeter[] = [];
  const add = (key: string, window: CodexQuotaWindow | null | undefined): void => {
    if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return;
    meters.push({
      key,
      usedPercent: Math.max(0, Math.min(100, window.used_percent)),
      windowSeconds: typeof window.limit_window_seconds === "number" &&
        Number.isFinite(window.limit_window_seconds) && window.limit_window_seconds > 0
        ? window.limit_window_seconds : null,
      resetAt: typeof window.reset_at === "number" && Number.isFinite(window.reset_at)
        ? window.reset_at : null,
    });
  };
  const limitId = getRateLimitIdForModel(options.model);
  const additional = limitId ? quota.rate_limits_by_limit_id?.[limitId] : null;
  if (additional) {
    add(limitId + ":primary", additional);
    add(limitId + ":secondary", additional.secondary_rate_limit);
  }
  if (meters.length === 0) {
    add("primary", quota.rate_limit);
    add("secondary", quota.secondary_rate_limit);
  }
  meters.sort((left, right) => {
    if (left.windowSeconds !== null && right.windowSeconds !== null) {
      return left.windowSeconds - right.windowSeconds;
    }
    if (left.windowSeconds !== null) return -1;
    if (right.windowSeconds !== null) return 1;
    return left.key === "primary" ? -1 : right.key === "primary" ? 1 : 0;
  });
  const nowMs = options.nowMs ?? Date.now();
  const maxQuotaAgeMs = options.maxQuotaAgeMs ?? 10 * 60_000;
  const isFresh = (meter: QuotaMeter): boolean => {
    const fetchedAt = entry.quotaFetchedAtByMeter
      ? entry.quotaFetchedAtByMeter[meter.key] : entry.quotaFetchedAt;
    const fetchedMs = Date.parse(fetchedAt ?? "");
    const ageMs = nowMs - fetchedMs;
    return Number.isFinite(fetchedMs) && Number.isFinite(nowMs) &&
      Number.isFinite(maxQuotaAgeMs) && ageMs >= 0 && ageMs <= maxQuotaAgeMs;
  };
  const selected = (requireFresh ? meters.filter(isFresh) : meters)[0];
  if (!selected) return [];
  return [selected];
}

// 100% closes the final partial bucket, including sizes that don't divide 100.
function bucketFor(usedPercent: number, batchPercent: number): number {
  return usedPercent >= 100 ? Math.ceil(100 / batchPercent) : Math.floor(usedPercent / batchPercent);
}

function limitTrackedMeters(meters: QuotaBucket[], activeKey: string | undefined): QuotaBucket[] {
  if (meters.length <= MAX_TRACKED_METERS) return meters;
  const active = activeKey ? meters.find((meter) => meter.key === activeKey) : undefined;
  if (!active) return meters.slice(-MAX_TRACKED_METERS);
  const history = meters.filter((meter) => meter.key !== active.key).slice(-(MAX_TRACKED_METERS - 1));
  return [...history, active];
}

function checkpointFor(entry: AccountEntry, batchPercent: number, options: SelectionOptions): QuotaBatchCheckpoint {
  return {
    version: 3,
    strategy: "quota_batch",
    batchPercent,
    currentEntryId: entry.id,
    meters: quotaMeters(entry, options).map((meter) => ({
      key: meter.key,
      windowSeconds: meter.windowSeconds,
      bucket: bucketFor(meter.usedPercent, batchPercent),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validCommonState(state: Record<string, unknown>): boolean {
  return state.strategy === "quota_batch" &&
    Number.isInteger(state.batchPercent) && (state.batchPercent as number) >= 1 &&
    (state.batchPercent as number) <= 100 &&
    typeof state.currentEntryId === "string" && state.currentEntryId.length > 0;
}

function isCheckpoint(value: unknown): value is QuotaBatchCheckpoint {
  if (!isRecord(value) || !hasKeys(value, ["version", "strategy", "batchPercent", "currentEntryId", "meters"]) ||
      value.version !== 3 || !validCommonState(value) || !Array.isArray(value.meters)) return false;
  const keys = new Set<string>();
  return value.meters.length <= MAX_TRACKED_METERS && value.meters.every((meter: unknown) => {
    if (!isRecord(meter) || !hasKeys(meter, ["key", "windowSeconds", "bucket"]) ||
        typeof meter.key !== "string" ||
        !/^[a-zA-Z0-9_.-]+(?::(?:primary|secondary))?$/.test(meter.key) ||
        keys.has(meter.key)) return false;
    keys.add(meter.key);
    return Number.isInteger(meter.bucket) && (meter.bucket as number) >= 0 &&
      (meter.bucket as number) <= Math.ceil(100 / (value.batchPercent as number)) &&
      (meter.windowSeconds === null || (typeof meter.windowSeconds === "number" &&
        Number.isFinite(meter.windowSeconds) && meter.windowSeconds > 0));
  });
}

/** Old relative-delta/request-count checkpoints retain only the routing cursor. */
function legacyEntryId(value: unknown): string | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !validCommonState(value)) return null;
  const keys = ["version", "strategy", "batchPercent", "currentEntryId", "baselineUsedPercent", "meter", "resetAt"];
  if (value.version === 2) keys.push("baselineRequestCount");
  if (!hasKeys(value, keys)) return null;
  const validBaseline = value.meter === null
    ? value.baselineUsedPercent === null && value.resetAt === null
    : (value.meter === "primary" || value.meter === "secondary") &&
      typeof value.baselineUsedPercent === "number" && Number.isFinite(value.baselineUsedPercent) &&
      value.baselineUsedPercent >= 0 && value.baselineUsedPercent <= 100 &&
      (value.resetAt === null || (typeof value.resetAt === "number" && Number.isFinite(value.resetAt) && value.resetAt >= 0));
  if (!validBaseline || (value.version === 2 &&
      (!Number.isInteger(value.baselineRequestCount) || (value.baselineRequestCount as number) < 0))) return null;
  return value.currentEntryId as string;
}

export class FileQuotaBatchStateStore implements QuotaBatchStateStore {
  constructor(private readonly path = resolve(getDataDir(), "quota-rotation-state.json")) {}

  load(): unknown {
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      console.warn("[QuotaBatch] Ignoring unreadable rotation checkpoint");
      return null;
    }
  }

  save(state: QuotaBatchCheckpoint): void {
    this.write(state);
  }

  clear(): void {
    this.write(null);
  }

  private write(state: QuotaBatchCheckpoint | null): void {
    const tempPath = this.path + ".tmp-" + process.pid;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, this.path);
    } catch {
      console.warn("[QuotaBatch] Unable to persist rotation checkpoint");
    }
  }
}

export class QuotaBatchSelector {
  private checkpoint: QuotaBatchCheckpoint | null = null;
  private legacyCurrentEntryId: string | null = null;

  constructor(private readonly store: QuotaBatchStateStore = new FileQuotaBatchStateStore()) {
    const loaded = store.load();
    if (isCheckpoint(loaded)) this.checkpoint = loaded;
    else this.legacyCurrentEntryId = legacyEntryId(loaded);
    if (loaded != null && !this.checkpoint && !this.legacyCurrentEntryId) {
      console.warn("[QuotaBatch] Ignoring invalid rotation checkpoint");
    }
  }

  select(
    candidates: AccountEntry[],
    batchPercent: number,
    registryOrder: string[] = candidates.map((candidate) => candidate.id),
    options: SelectionOptions = {},
  ): AccountEntry {
    if (candidates.length === 0) throw new Error("QuotaBatchSelector requires at least one candidate");
    if (!Number.isInteger(batchPercent) || batchPercent < 1 || batchPercent > 100) {
      throw new Error("quota batch percentage must be an integer from 1 to 100");
    }
    const prior = this.checkpoint;
    const currentId = prior?.currentEntryId ?? this.legacyCurrentEntryId;
    const current = candidates.find((candidate) => candidate.id === currentId);
    this.legacyCurrentEntryId = null;
    if (!prior || !current || prior.batchPercent !== batchPercent) {
      const selected = current ?? (currentId ? nextEligibleCandidate(currentId, candidates, registryOrder) : candidates[0]);
      this.updateCheckpoint(checkpointFor(selected, batchPercent, options));
      return selected;
    }

    const meters = quotaMeters(current, options);
    // Missing/stale telemetry must not silently become sticky mode. Once an
    // account publishes quota again, establish its buckets and stay within them.
    let shouldRotate = meters.length === 0;
    const nextMeters = prior.meters.map((meter) => ({ ...meter }));
    for (const meter of meters) {
      const bucket = bucketFor(meter.usedPercent, batchPercent);
      const saved = nextMeters.find((item) => item.key === meter.key);
      if (!saved) {
        nextMeters.push({ key: meter.key, bucket, windowSeconds: meter.windowSeconds });
        continue;
      }
      // Missing duration metadata on a partial response is not a new window.
      const windowChanged = saved.windowSeconds !== null && meter.windowSeconds !== null &&
        saved.windowSeconds !== meter.windowSeconds;
      if (!windowChanged && bucket > saved.bucket) shouldRotate = true;
      if (windowChanged || bucket < saved.bucket) saved.bucket = bucket;
      if (meter.windowSeconds !== null) saved.windowSeconds = meter.windowSeconds;
    }
    if (!shouldRotate) {
      // Preserve temporarily missing meters across partial quota reports.
      // reset_at drift alone is not a reset.
      this.updateCheckpoint({
        ...prior,
        meters: limitTrackedMeters(nextMeters, meters[0]?.key),
      });
      return current;
    }

    const selected = nextEligibleCandidate(current.id, candidates, registryOrder);
    this.updateCheckpoint(checkpointFor(selected, batchPercent, options));
    return selected;
  }

  reset(): void {
    this.checkpoint = null;
    this.legacyCurrentEntryId = null;
    this.store.clear();
  }

  private updateCheckpoint(next: QuotaBatchCheckpoint): void {
    if (this.checkpoint && JSON.stringify(this.checkpoint) === JSON.stringify(next)) return;
    this.checkpoint = next;
    this.store.save(next);
  }
}

function nextEligibleCandidate(currentEntryId: string, candidates: AccountEntry[], registryOrder: string[]): AccountEntry {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const currentIndex = registryOrder.indexOf(currentEntryId);
  if (currentIndex >= 0) {
    for (let offset = 1; offset <= registryOrder.length; offset++) {
      const candidate = byId.get(registryOrder[(currentIndex + offset) % registryOrder.length]);
      if (candidate) return candidate;
    }
  }
  return candidates[0];
}
