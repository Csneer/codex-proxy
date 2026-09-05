import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountEntry, CodexQuota } from "@src/auth/types.js";
import {
  QuotaBatchSelector,
  FileQuotaBatchStateStore,
  type QuotaBatchCheckpoint,
  type QuotaBatchStateStore,
  effectiveQuotaMeter,
} from "@src/auth/quota-batch-selector.js";

afterEach(() => vi.restoreAllMocks());

class MemoryStateStore implements QuotaBatchStateStore {
  state: QuotaBatchCheckpoint | null = null;

  load(): QuotaBatchCheckpoint | null {
    return this.state ? structuredClone(this.state) : null;
  }

  save(state: QuotaBatchCheckpoint): void {
    this.state = structuredClone(state);
  }

  clear(): void {
    this.state = null;
  }
}

function quota(
  primary: number | null,
  secondary: number | null = null,
  primaryReset = 1000,
  secondaryReset = 2000,
): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: primary,
      reset_at: primaryReset,
      limit_window_seconds: 18_000,
    },
    secondary_rate_limit: secondary === null ? null : {
      limit_reached: false,
      used_percent: secondary,
      reset_at: secondaryReset,
      limit_window_seconds: 604_800,
    },
    code_review_rate_limit: null,
  };
}

function entry(id: string, primary: number | null, secondary: number | null = null): AccountEntry {
  return {
    id,
    token: `token-${id}`,
    refreshToken: null,
    email: `${id}@test.invalid`,
    accountId: id,
    userId: id,
    label: null,
    planType: "plus",
    proxyApiKey: `key-${id}`,
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
    },
    addedAt: new Date(0).toISOString(),
    cachedQuota: quota(primary, secondary),
    quotaFetchedAt: new Date().toISOString(),
  };
}

describe("effectiveQuotaMeter", () => {
  it("prefers the shortest finite published window", () => {
    expect(effectiveQuotaMeter(entry("a", 12, 34))).toEqual({
      kind: "primary",
      usedPercent: 12,
      resetAt: 1000,
      windowSeconds: 18_000,
    });
  });

  it("uses a longer window when the shorter window has no usable duration", () => {
    const account = entry("a", 12, 34);
    account.cachedQuota!.rate_limit.limit_window_seconds = null;
    expect(effectiveQuotaMeter(account)).toEqual({
      kind: "secondary",
      usedPercent: 34,
      resetAt: 2000,
      windowSeconds: 604_800,
    });
  });

  it("falls back to a finite primary meter", () => {
    expect(effectiveQuotaMeter(entry("a", 12))).toEqual({
      kind: "primary",
      usedPercent: 12,
      resetAt: 1000,
      windowSeconds: 18_000,
    });
  });

  it("returns null when no finite usage percentage exists", () => {
    expect(effectiveQuotaMeter(entry("a", null))).toBeNull();
    const invalid = entry("b", 10);
    invalid.cachedQuota!.rate_limit.used_percent = Number.NaN;
    expect(effectiveQuotaMeter(invalid)).toBeNull();
  });

  it("uses duration rather than primary/secondary labels or plan names", () => {
    const a = entry("a", 17, 38);
    a.planType = "unknown-new-plan";
    a.cachedQuota!.rate_limit.limit_window_seconds = 2_592_000;
    a.cachedQuota!.secondary_rate_limit!.limit_window_seconds = 604_800;
    expect(effectiveQuotaMeter(a)).toMatchObject({ kind: "secondary", windowSeconds: 604_800 });
    a.cachedQuota!.secondary_rate_limit!.limit_window_seconds = 7_777;
    expect(effectiveQuotaMeter(a)).toMatchObject({ kind: "secondary", windowSeconds: 7_777 });
  });

  it("can use a percentage even if both window durations are unavailable", () => {
    const a = entry("a", 17, 38);
    a.cachedQuota!.rate_limit.limit_window_seconds = null;
    a.cachedQuota!.secondary_rate_limit!.limit_window_seconds = null;
    expect(effectiveQuotaMeter(a)).toMatchObject({ kind: "primary", usedPercent: 17, windowSeconds: null });
  });
});

describe("QuotaBatchSelector", () => {
  let store: MemoryStateStore;
  let selector: QuotaBatchSelector;

  beforeEach(() => {
    store = new MemoryStateStore();
    selector = new QuotaBatchSelector(store);
  });

  it("establishes a fixed absolute boundary", () => {
    const a = entry("a", 90, 12);
    const b = entry("b", 0, 0);

    expect(selector.select([a, b], 30)).toBe(a);
    expect(store.state).toMatchObject({
      currentEntryId: "a",
      meters: [{ key: "primary", bucket: 3, windowSeconds: 18_000 }],
      batchPercent: 30,
    });

    a.cachedQuota = quota(99, 41);
    expect(selector.select([a, b], 30)).toBe(a);
  });

  it.each([20, 30, 40])("advances once at a %i-point absolute boundary and wraps", (batchPercent) => {
    const a = entry("a", 10);
    const b = entry("b", 50);
    const c = entry("c", 70);
    selector.select([a, b, c], batchPercent);

    a.cachedQuota = quota(10 + batchPercent);
    expect(selector.select([a, b, c], batchPercent)).toBe(b);
    expect(selector.select([a, b, c], batchPercent)).toBe(b);

    b.cachedQuota = quota(50 + batchPercent);
    expect(selector.select([a, b, c], batchPercent)).toBe(c);
    c.cachedQuota = quota(70 + batchPercent);
    expect(selector.select([a, b, c], batchPercent)).toBe(a);
  });

  it("switches at the next absolute bucket boundary, not after a relative delta", () => {
    const a = entry("a", 37);
    const b = entry("b", 0);
    selector.select([a, b], 10);

    a.cachedQuota = quota(39);
    expect(selector.select([a, b], 10)).toBe(a);
    a.cachedQuota = quota(40);
    expect(selector.select([a, b], 10)).toBe(b);
  });

  it("keeps accumulated quota progress when a sliding window moves reset_at", () => {
    const a = entry("a", 10);
    const b = entry("b", 0);
    selector.select([a, b], 10);

    a.cachedQuota = quota(15, null, 1005);
    expect(selector.select([a, b], 10)).toBe(a);
    a.cachedQuota = quota(20, null, 1010);
    expect(selector.select([a, b], 10)).toBe(b);
  });

  it("keeps accumulated quota progress across long-running sliding-window drift", () => {
    const a = entry("a", 10);
    const b = entry("b", 0);
    selector.select([a, b], 10);

    a.cachedQuota = quota(15, null, 10_000);
    expect(selector.select([a, b], 10)).toBe(a);
    a.cachedQuota = quota(20, null, 20_000);
    expect(selector.select([a, b], 10)).toBe(b);
  });

  it("does not rotate from request count while recent quota stays within the bucket", () => {
    const a = entry("a", 10);
    const b = entry("b", 10);
    selector.select([a, b], 10);

    a.usage.request_count = 100;
    expect(selector.select([a, b], 10)).toBe(a);
  });

  it.each([1, 30, 60, 100])("closes the last partial bucket at 100%% with size %i", (percent) => {
    const a = entry("a", 99);
    const b = entry("b", 0);
    expect(selector.select([a, b], percent)).toBe(a);
    a.cachedQuota = quota(100);
    expect(selector.select([a, b], percent)).toBe(b);
    expect(selector.select([a, b], percent)).toBe(b);
  });

  it("only switches once after an overshoot across several buckets", () => {
    const a = entry("a", 7);
    const b = entry("b", 22);
    const c = entry("c", 33);
    selector.select([a, b, c], 10);
    a.cachedQuota = quota(46);
    expect(selector.select([a, b, c], 10)).toBe(b);
    expect(selector.select([a, b, c], 10)).toBe(b);
    a.cachedQuota = quota(60); // A's delayed in-flight completion cannot move B.
    expect(selector.select([a, b, c], 10)).toBe(b);
    b.cachedQuota = quota(31);
    expect(selector.select([a, b, c], 10)).toBe(c);
  });

  it("re-buckets when an official duration changes instead of comparing different windows", () => {
    const a = entry("a", 17);
    const b = entry("b", 0);
    selector.select([a, b], 10);
    a.cachedQuota = quota(38);
    a.cachedQuota.rate_limit.limit_window_seconds = 2_592_000;
    expect(selector.select([a, b], 10)).toBe(a);
    expect(store.state?.meters[0]).toMatchObject({ bucket: 3, windowSeconds: 2_592_000 });
    a.cachedQuota.rate_limit.used_percent = 40;
    expect(selector.select([a, b], 10)).toBe(b);
  });

  it("does not lose a bucket when partial reports omit the duration or selected window", () => {
    const a = entry("a", 37, 7);
    const b = entry("b", 0);
    selector.select([a, b], 10);
    a.cachedQuota = quota(null, 9);
    expect(selector.select([a, b], 10)).toBe(a);
    a.cachedQuota = quota(40, 9);
    expect(selector.select([a, b], 10)).toBe(b);

    b.cachedQuota = quota(10);
    b.cachedQuota.rate_limit.limit_window_seconds = null;
    expect(selector.select([a, b], 10)).toBe(a);
  });

  it("honors telemetry freshness and resumes batching when quota returns", () => {
    const a = entry("a", 7);
    const b = entry("b", 0);
    const fetched = Date.parse(a.quotaFetchedAt!);
    const options = { nowMs: fetched, maxQuotaAgeMs: 60_000 };
    selector.select([a, b], 10, undefined, options);
    expect(selector.select([a, b], 10, undefined, { ...options, nowMs: fetched + 60_000 })).toBe(a);
    expect(selector.select([a, b], 10, undefined, { ...options, nowMs: fetched + 60_001 })).toBe(b);
    b.quotaFetchedAt = new Date(fetched + 60_001).toISOString();
    expect(selector.select([a, b], 10, undefined, { ...options, nowMs: fetched + 60_001 })).toBe(b);
    b.cachedQuota = quota(10);
    expect(selector.select([a, b], 10, undefined, { ...options, nowMs: fetched + 60_001 })).toBe(a);
  });

  it("treats a quota timestamp from the future as stale telemetry", () => {
    const a = entry("a", 7);
    const b = entry("b", 0);
    const fetched = Date.parse(a.quotaFetchedAt!);
    const options = { nowMs: fetched - 1, maxQuotaAgeMs: 60_000 };

    expect(selector.select([a, b], 10, undefined, options)).toBe(a);
    expect(selector.select([a, b], 10, undefined, options)).toBe(b);
  });

  it("only uses a model-specific bucket for matching requests", () => {
    const a = entry("a", 17);
    const b = entry("b", 0);
    a.cachedQuota!.rate_limits_by_limit_id = {
      codex_bengalfox: {
        limit_id: "codex_bengalfox", limit_name: "Spark", allowed: true, limit_reached: false,
        used_percent: 37, reset_at: 1000, limit_window_seconds: 604_800,
      },
    };
    selector.select([a, b], 10, undefined, { model: "gpt-5.4" });
    a.cachedQuota!.rate_limits_by_limit_id!.codex_bengalfox.used_percent = 40;
    expect(selector.select([a, b], 10, undefined, { model: "gpt-5.4" })).toBe(a);
    expect(selector.select([a, b], 10, undefined, { model: "gpt-5.3-codex-spark" })).toBe(a);
    a.cachedQuota!.rate_limits_by_limit_id!.codex_bengalfox.used_percent = 50;
    expect(selector.select([a, b], 10, undefined, { model: "gpt-5.3-codex-spark" })).toBe(b);
  });

  it("keeps runtime meter history within the persisted checkpoint limit", () => {
    store.state = {
      version: 3,
      strategy: "quota_batch",
      batchPercent: 10,
      currentEntryId: "a",
      meters: [
        { key: "old-1:primary", windowSeconds: 1, bucket: 0 },
        { key: "old-2:primary", windowSeconds: 2, bucket: 0 },
        { key: "old-3:primary", windowSeconds: 3, bucket: 0 },
        { key: "old-4:primary", windowSeconds: 4, bucket: 0 },
      ],
    };
    const a = entry("a", 17);
    const b = entry("b", 0);
    a.cachedQuota!.rate_limits_by_limit_id = {
      codex_bengalfox: {
        limit_id: "codex_bengalfox", limit_name: "Spark", allowed: true, limit_reached: false,
        used_percent: 37, reset_at: 1000, limit_window_seconds: 604_800,
      },
    };

    const restored = new QuotaBatchSelector(store);
    expect(restored.select([a, b], 10, undefined, { model: "gpt-5.3-codex-spark" })).toBe(a);
    expect(store.state?.meters).toHaveLength(4);
    expect(store.state?.meters).toContainEqual({
      key: "codex_bengalfox:primary",
      windowSeconds: 604_800,
      bucket: 3,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reloaded = new QuotaBatchSelector(store);
    expect(warn).not.toHaveBeenCalled();
    a.cachedQuota!.rate_limits_by_limit_id!.codex_bengalfox.used_percent = 40;
    expect(reloaded.select([a, b], 10, undefined, { model: "gpt-5.3-codex-spark" })).toBe(b);
  });

  it("re-baselines when the selected calculated window changes", () => {
    const a = entry("a", 10);
    const b = entry("b", 10);
    selector.select([a, b], 10);

    a.cachedQuota = quota(null, 5);
    expect(selector.select([a, b], 10)).toBe(a);
    expect(store.state).toMatchObject({
      meters: expect.arrayContaining([{ key: "secondary", bucket: 0, windowSeconds: 604_800 }]),
    });
  });

  it("re-baselines after a quota reset before starting the next bucket", () => {
    const a = entry("a", 10);
    const b = entry("b", 10);
    selector.select([a, b], 10);

    a.cachedQuota = quota(5);
    expect(selector.select([a, b], 10)).toBe(a);
    a.cachedQuota = quota(10);
    expect(selector.select([a, b], 10)).toBe(b);
  });

  it("temporarily rotates instead of sticking when quota is unknown", () => {
    const a = entry("a", null);
    const b = entry("b", null);

    expect(selector.select([a, b], 30)).toBe(a);
    expect(selector.select([a, b], 30)).toBe(b);
    expect(store.state?.meters).toEqual([]);
    expect(selector.select([a, b], 30)).toBe(a);
  });

  it.each([
    ["usage decrease", quota(10)],
    ["meter change", quota(null, 7)],
  ])("re-baselines on %s", (_label, changedQuota) => {
    const a = entry("a", 40);
    const b = entry("b", 0);
    selector.select([a, b], 30);
    a.cachedQuota = changedQuota;

    expect(selector.select([a, b], 30)).toBe(a);
    const meter = effectiveQuotaMeter(a)!;
    expect(store.state?.meters).toContainEqual({
      key: meter.kind,
      bucket: Math.floor(meter.usedPercent / 30),
      windowSeconds: meter.windowSeconds,
    });
  });

  it("re-baselines when the configured percentage changes", () => {
    const a = entry("a", 10);
    const b = entry("b", 0);
    selector.select([a, b], 20);
    a.cachedQuota = quota(30);

    expect(selector.select([a, b], 40)).toBe(a);
    expect(store.state).toMatchObject({ batchPercent: 40, meters: [{ key: "primary", bucket: 0 }] });
  });

  it("recomputes the next absolute boundary when the configured percentage changes", () => {
    const a = entry("a", 10);
    const b = entry("b", 0);
    selector.select([a, b], 10);
    a.usage.request_count = 99;
    a.cachedQuota = quota(15);

    expect(selector.select([a, b], 20)).toBe(a);
    expect(store.state).toMatchObject({
      batchPercent: 20,
      meters: [{ key: "primary", bucket: 0 }],
    });
  });

  it("does not use request count as a hidden boundary after percentage changes", () => {
    const a = entry("a", 10);
    const b = entry("b", 0);
    selector.select([a, b], 10);
    a.usage.request_count = 100;
    a.cachedQuota = quota(15);

    expect(selector.select([a, b], 20)).toBe(a);
  });

  it("advances in registry order when the current account becomes ineligible", () => {
    const a = entry("a", 10);
    const b = entry("b", 20);
    const c = entry("c", 30);
    selector.select([a, b, c], 30, ["a", "b", "c"]);

    expect(selector.select([b, c], 30, ["a", "b", "c"])).toBe(b);
    expect(selector.select([a, c], 30, ["a", "b", "c"])).toBe(c);
  });

  it("keeps a single candidate usable and re-baselines after its threshold", () => {
    const a = entry("a", 10);
    expect(selector.select([a], 20)).toBe(a);
    a.cachedQuota = quota(30);
    expect(selector.select([a], 20)).toBe(a);
    expect(store.state?.meters[0].bucket).toBe(1);
  });

  it("restores a credential-free checkpoint in a new selector", () => {
    const a = entry("a", 10);
    const b = entry("b", 20);
    selector.select([a, b], 30);
    a.cachedQuota = quota(25);

    const restored = new QuotaBatchSelector(store);
    expect(restored.select([a, b], 30)).toBe(a);
    expect(JSON.stringify(store.state)).not.toContain("token-a");
    expect(JSON.stringify(store.state)).not.toContain("@test.invalid");
  });

  it.each([1, 2])("upgrades a v%i checkpoint without jumping back to the first account", (version) => {
    store.state = {
      version,
      ...(version === 2 ? { baselineRequestCount: 50 } : {}),
      strategy: "quota_batch",
      batchPercent: 10,
      currentEntryId: "b",
      baselineUsedPercent: 20,
      meter: "primary",
      resetAt: 1000,
    } as unknown as QuotaBatchCheckpoint;
    const restored = new QuotaBatchSelector(store);
    const a = entry("a", 10);
    const b = entry("b", 25);
    b.usage.request_count = 50;

    expect(restored.select([a, b], 10)).toBe(b);
    expect(store.state).toMatchObject({
      version: 3,
      currentEntryId: "b",
      meters: [{ key: "primary", bucket: 2, windowSeconds: 18_000 }],
    });
  });

  it("advances from an ineligible v1 checkpoint in registry order", () => {
    store.state = {
      version: 1,
      strategy: "quota_batch",
      batchPercent: 10,
      currentEntryId: "b",
      baselineUsedPercent: 20,
      meter: "primary",
      resetAt: 1000,
    } as unknown as QuotaBatchCheckpoint;
    const restored = new QuotaBatchSelector(store);
    const a = entry("a", 10);
    const c = entry("c", 10);

    expect(restored.select([a, c], 10, ["a", "b", "c"])).toBe(c);
    expect(store.state).toMatchObject({ version: 3, currentEntryId: "c" });
  });

  it("fails open when persisted state is corrupt", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store.state = { version: 99 } as unknown as QuotaBatchCheckpoint;
    const fresh = new QuotaBatchSelector(store);
    const a = entry("a", 10);

    expect(fresh.select([a], 30)).toBe(a);
    expect(store.state).toMatchObject({ version: 3, currentEntryId: "a" });
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    { version: 2, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 10, baselineRequestCount: 0, meter: "primary", resetAt: 1000, token: "secret" },
    { version: 2, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: -1, baselineRequestCount: 0, meter: "primary", resetAt: 1000 },
    { version: 2, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 101, baselineRequestCount: 0, meter: "primary", resetAt: 1000 },
    { version: 2, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 10, baselineRequestCount: 0, meter: null, resetAt: null },
    { version: 2, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 10, baselineRequestCount: 0, meter: "primary", resetAt: -1 },
    { version: 2, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 10, baselineRequestCount: -1, meter: "primary", resetAt: 1000 },
  ])("rejects semantically invalid or credential-bearing checkpoints", (invalid) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store.state = invalid as unknown as QuotaBatchCheckpoint;
    const fresh = new QuotaBatchSelector(store);
    expect(fresh.select([entry("a", 25)], 30)).toBeDefined();
    expect(store.state).toMatchObject({ meters: [{ key: "primary", bucket: 0 }], version: 3 });
    expect(store.state).not.toHaveProperty("token");
  });

  it("clears persisted state on reset", () => {
    selector.select([entry("a", 10)], 30);
    selector.reset();
    expect(store.state).toBeNull();
  });

  it("restores boundary progress through real file persistence with no credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "quota-batch-test-"));
    const path = join(directory, "nested", "state.json");
    try {
      const fileStore = new FileQuotaBatchStateStore(path);
      expect(fileStore.load()).toBeNull();
      const a = entry("a", 37);
      const b = entry("b", 0);
      new QuotaBatchSelector(fileStore).select([a, b], 10);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const contents = readFileSync(path, "utf8");
      expect(contents).not.toMatch(/token-|key-|@test/);
      a.cachedQuota = quota(40);
      const restored = new QuotaBatchSelector(new FileQuotaBatchStateStore(path));
      expect(restored.select([a, b], 10)).toBe(b);
      expect(new QuotaBatchSelector(new FileQuotaBatchStateStore(path)).select([a, b], 10)).toBe(b);
      restored.reset();
      expect(fileStore.load()).toBeNull();
      expect(new QuotaBatchSelector(fileStore).select([a, b], 10)).toBe(a);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0, 101, 0.5, Number.NaN])("rejects invalid runtime batch size %s", (percent) => {
    expect(() => selector.select([entry("a", 0)], percent)).toThrow(/integer/);
  });

  it.each([
    { key: "primary", windowSeconds: 0, bucket: 1 },
    { key: "primary", windowSeconds: 18_000, bucket: -1 },
    { key: "primary", windowSeconds: 18_000, bucket: 11 },
    { key: "primary", windowSeconds: 18_000, bucket: 1.2 },
    { key: "primary", windowSeconds: 18_000, bucket: 1, token: "secret" },
  ])("rejects invalid or credential-bearing v3 meters", (meter) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fresh = new QuotaBatchSelector({ ...store,
      load: () => ({ version: 3, strategy: "quota_batch", batchPercent: 10, currentEntryId: "b", meters: [meter] }),
      save: (state) => store.save(state), clear: () => store.clear(),
    });
    expect(fresh.select([entry("a", 0), entry("b", 0)], 10).id).toBe("a");
    expect(warn).toHaveBeenCalled();
  });
});
