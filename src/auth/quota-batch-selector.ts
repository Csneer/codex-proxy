import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { getDataDir } from "../paths.js";
import type { AccountEntry } from "./types.js";

const REQUEST_BATCH_FALLBACK = 100;

export type QuotaMeterKind = "secondary" | "primary";

export interface EffectiveQuotaMeter {
  kind: QuotaMeterKind;
  usedPercent: number;
  resetAt: number | null;
}

export interface QuotaBatchCheckpoint {
  version: 2;
  strategy: "quota_batch";
  batchPercent: number;
  currentEntryId: string;
  baselineUsedPercent: number | null;
  baselineRequestCount: number;
  meter: QuotaMeterKind | null;
  resetAt: number | null;
}

interface LegacyQuotaBatchCheckpoint {
  version: 1;
  strategy: "quota_batch";
  batchPercent: number;
  currentEntryId: string;
  baselineUsedPercent: number | null;
  meter: QuotaMeterKind | null;
  resetAt: number | null;
}

export interface QuotaBatchStateStore {
  load(): unknown;
  save(state: QuotaBatchCheckpoint): void;
  clear(): void;
}

export function effectiveQuotaMeter(entry: AccountEntry): EffectiveQuotaMeter | null {
  const secondary = entry.cachedQuota?.secondary_rate_limit;
  if (secondary && Number.isFinite(secondary.used_percent)) {
    return {
      kind: "secondary",
      usedPercent: secondary.used_percent as number,
      resetAt: finiteNumberOrNull(secondary.reset_at),
    };
  }

  const primary = entry.cachedQuota?.rate_limit;
  if (primary && Number.isFinite(primary.used_percent)) {
    return {
      kind: "primary",
      usedPercent: primary.used_percent as number,
      resetAt: finiteNumberOrNull(primary.reset_at),
    };
  }

  return null;
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? value as number : null;
}

function isCheckpoint(value: unknown): value is QuotaBatchCheckpoint {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const expectedKeys = [
    "version", "strategy", "batchPercent", "currentEntryId",
    "baselineUsedPercent", "baselineRequestCount", "meter", "resetAt",
  ];
  if (Object.keys(state).length !== expectedKeys.length ||
      !Object.keys(state).every((key) => expectedKeys.includes(key))) return false;
  const meterIsNull = state.meter === null;
  const baselineIsValid = meterIsNull
    ? state.baselineUsedPercent === null && state.resetAt === null
    : typeof state.baselineUsedPercent === "number" &&
      Number.isFinite(state.baselineUsedPercent) &&
      state.baselineUsedPercent >= 0 && state.baselineUsedPercent <= 100 &&
      (state.resetAt === null ||
        (typeof state.resetAt === "number" && Number.isFinite(state.resetAt) && state.resetAt >= 0));
  return state.version === 2 &&
    state.strategy === "quota_batch" &&
    Number.isInteger(state.batchPercent) &&
    (state.batchPercent as number) >= 1 &&
    (state.batchPercent as number) <= 100 &&
    typeof state.currentEntryId === "string" &&
    state.currentEntryId.length > 0 &&
    Number.isInteger(state.baselineRequestCount) &&
    (state.baselineRequestCount as number) >= 0 &&
    (state.meter === null || state.meter === "secondary" || state.meter === "primary") &&
    baselineIsValid;
}

function isLegacyCheckpoint(value: unknown): value is LegacyQuotaBatchCheckpoint {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const expectedKeys = [
    "version", "strategy", "batchPercent", "currentEntryId",
    "baselineUsedPercent", "meter", "resetAt",
  ];
  if (Object.keys(state).length !== expectedKeys.length ||
      !Object.keys(state).every((key) => expectedKeys.includes(key))) return false;
  return state.version === 1 &&
    state.strategy === "quota_batch" &&
    Number.isInteger(state.batchPercent) &&
    (state.batchPercent as number) >= 1 &&
    (state.batchPercent as number) <= 100 &&
    typeof state.currentEntryId === "string" &&
    state.currentEntryId.length > 0 &&
    (state.baselineUsedPercent === null ||
      (typeof state.baselineUsedPercent === "number" &&
        Number.isFinite(state.baselineUsedPercent) &&
        state.baselineUsedPercent >= 0 && state.baselineUsedPercent <= 100)) &&
    (state.meter === null || state.meter === "secondary" || state.meter === "primary") &&
    (state.resetAt === null ||
      (typeof state.resetAt === "number" && Number.isFinite(state.resetAt) && state.resetAt >= 0));
}

export class FileQuotaBatchStateStore implements QuotaBatchStateStore {
  private readonly path: string;

  constructor(path = resolve(getDataDir(), "quota-rotation-state.json")) {
    this.path = path;
  }

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
    const tempPath = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tempPath, this.path);
    } catch {
      console.warn("[QuotaBatch] Unable to persist rotation checkpoint");
    }
  }

  clear(): void {
    // An empty checkpoint is deliberately represented by a missing/invalid
    // logical state. Avoid an unlink dependency so embedded/mock stores stay
    // compatible; the next selection atomically replaces this file.
    this.saveNullCheckpoint();
  }

  private saveNullCheckpoint(): void {
    const tempPath = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tempPath, "null\n", { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, this.path);
    } catch {
      console.warn("[QuotaBatch] Unable to clear rotation checkpoint");
    }
  }
}

export class QuotaBatchSelector {
  private checkpoint: QuotaBatchCheckpoint | null;
  private legacyCheckpoint: LegacyQuotaBatchCheckpoint | null = null;

  constructor(private readonly store: QuotaBatchStateStore = new FileQuotaBatchStateStore()) {
    const loaded = store.load();
    if (loaded === null || loaded === undefined) {
      this.checkpoint = null;
    } else if (isCheckpoint(loaded)) {
      this.checkpoint = loaded;
    } else if (isLegacyCheckpoint(loaded)) {
      this.checkpoint = null;
      this.legacyCheckpoint = loaded;
    } else {
      console.warn("[QuotaBatch] Ignoring invalid rotation checkpoint");
      this.checkpoint = null;
    }
  }

  select(
    candidates: AccountEntry[],
    batchPercent: number,
    registryOrder: string[] = candidates.map((candidate) => candidate.id),
  ): AccountEntry {
    if (candidates.length === 0) throw new Error("QuotaBatchSelector requires at least one candidate");
    if (!Number.isInteger(batchPercent) || batchPercent < 1 || batchPercent > 100) {
      throw new Error("quota batch percentage must be an integer from 1 to 100");
    }

    const prior = this.checkpoint;
    if (!prior && this.legacyCheckpoint) {
      const legacyEntryId = this.legacyCheckpoint.currentEntryId;
      const legacyCurrent = candidates.find(
        (candidate) => candidate.id === legacyEntryId,
      );
      this.legacyCheckpoint = null;
      if (legacyCurrent) {
        this.updateCheckpoint(checkpointFor(legacyCurrent, batchPercent));
        return legacyCurrent;
      }
      const selected = nextEligibleCandidate(legacyEntryId, candidates, registryOrder);
      this.updateCheckpoint(checkpointFor(selected, batchPercent));
      return selected;
    }
    const current = prior
      ? candidates.find((candidate) => candidate.id === prior.currentEntryId)
      : undefined;

    if (!prior || !current) {
      const selected = prior
        ? nextEligibleCandidate(prior.currentEntryId, candidates, registryOrder)
        : candidates[0];
      this.updateCheckpoint(checkpointFor(selected, batchPercent));
      return selected;
    }

    const meter = effectiveQuotaMeter(current);
    const rebaseline = rebaselineKind(prior, current, meter, batchPercent);
    if (rebaseline !== null) {
      if (rebaseline === "quota" &&
          current.usage.request_count - prior.baselineRequestCount >= REQUEST_BATCH_FALLBACK) {
        const selected = nextEligibleCandidate(current.id, candidates, registryOrder);
        this.updateCheckpoint(checkpointFor(selected, batchPercent));
        return selected;
      }
      this.updateCheckpoint(
        rebaseline === "all"
          ? checkpointFor(current, batchPercent)
          : checkpointForQuota(current, prior, batchPercent),
      );
      return current;
    }

    // Quota signals remain the preferred batch boundary. Completed requests
    // provide a deterministic upper bound when upstream quota is missing,
    // stale, rounded, or backed by a slow-moving weekly window.
    const quotaBatchComplete = meter !== null && prior.baselineUsedPercent !== null &&
      meter.usedPercent - prior.baselineUsedPercent >= batchPercent;
    const requestBatchComplete =
      current.usage.request_count - prior.baselineRequestCount >= REQUEST_BATCH_FALLBACK;
    if (!quotaBatchComplete && !requestBatchComplete) {
      return current;
    }

    const selected = nextEligibleCandidate(current.id, candidates, registryOrder);
    this.updateCheckpoint(checkpointFor(selected, batchPercent));
    return selected;
  }

  reset(): void {
    this.checkpoint = null;
    this.legacyCheckpoint = null;
    this.store.clear();
  }

  private updateCheckpoint(next: QuotaBatchCheckpoint): void {
    if (this.checkpoint && JSON.stringify(this.checkpoint) === JSON.stringify(next)) return;
    this.checkpoint = next;
    this.store.save(next);
  }
}

function checkpointFor(entry: AccountEntry, batchPercent: number): QuotaBatchCheckpoint {
  const meter = effectiveQuotaMeter(entry);
  return {
    version: 2,
    strategy: "quota_batch",
    batchPercent,
    currentEntryId: entry.id,
    baselineUsedPercent: meter?.usedPercent ?? null,
    baselineRequestCount: entry.usage.request_count,
    meter: meter?.kind ?? null,
    resetAt: meter?.resetAt ?? null,
  };
}

function checkpointForQuota(
  entry: AccountEntry,
  checkpoint: QuotaBatchCheckpoint,
  batchPercent: number,
): QuotaBatchCheckpoint {
  const meter = effectiveQuotaMeter(entry);
  return {
    ...checkpoint,
    batchPercent,
    baselineUsedPercent: meter?.usedPercent ?? null,
    meter: meter?.kind ?? null,
    resetAt: meter?.resetAt ?? null,
  };
}

function rebaselineKind(
  checkpoint: QuotaBatchCheckpoint,
  entry: AccountEntry,
  meter: EffectiveQuotaMeter | null,
  batchPercent: number,
): "all" | "quota" | null {
  if (entry.usage.request_count < checkpoint.baselineRequestCount) return "all";
  if (checkpoint.batchPercent !== batchPercent) return "quota";
  if (checkpoint.meter !== (meter?.kind ?? null)) return "quota";
  // A sliding window may move reset_at on every response. Re-baseline only
  // when the observed usage actually decreases, which is the reliable reset
  // signal and preserves accumulated progress across timestamp drift.
  if (meter && checkpoint.baselineUsedPercent !== null && meter.usedPercent < checkpoint.baselineUsedPercent) return "quota";
  return null;
}

function nextEligibleCandidate(
  currentEntryId: string,
  candidates: AccountEntry[],
  registryOrder: string[],
): AccountEntry {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const currentIndex = registryOrder.indexOf(currentEntryId);
  if (currentIndex >= 0) {
    for (let offset = 1; offset <= registryOrder.length; offset++) {
      const id = registryOrder[(currentIndex + offset) % registryOrder.length];
      const candidate = byId.get(id);
      if (candidate) return candidate;
    }
  }
  return candidates[0];
}
