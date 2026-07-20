import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountEntry, CodexQuota } from "@src/auth/types.js";
import {
  QuotaBatchSelector,
  type QuotaBatchCheckpoint,
  type QuotaBatchStateStore,
  effectiveQuotaMeter,
} from "@src/auth/quota-batch-selector.js";

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
  it("prefers a finite weekly secondary meter", () => {
    expect(effectiveQuotaMeter(entry("a", 12, 34))).toEqual({
      kind: "secondary",
      usedPercent: 34,
      resetAt: 2000,
    });
  });

  it("falls back to a finite primary meter", () => {
    expect(effectiveQuotaMeter(entry("a", 12))).toEqual({
      kind: "primary",
      usedPercent: 12,
      resetAt: 1000,
    });
  });

  it("returns null when no finite usage percentage exists", () => {
    expect(effectiveQuotaMeter(entry("a", null))).toBeNull();
    const invalid = entry("b", 10);
    invalid.cachedQuota!.rate_limit.used_percent = Number.NaN;
    expect(effectiveQuotaMeter(invalid)).toBeNull();
  });
});

describe("QuotaBatchSelector", () => {
  let store: MemoryStateStore;
  let selector: QuotaBatchSelector;

  beforeEach(() => {
    store = new MemoryStateStore();
    selector = new QuotaBatchSelector(store);
  });

  it("establishes a baseline and repeats below the configured delta", () => {
    const a = entry("a", 90, 12);
    const b = entry("b", 0, 0);

    expect(selector.select([a, b], 30)).toBe(a);
    expect(store.state).toMatchObject({
      currentEntryId: "a",
      baselineUsedPercent: 12,
      meter: "secondary",
      batchPercent: 30,
    });

    a.cachedQuota = quota(99, 41);
    expect(selector.select([a, b], 30)).toBe(a);
  });

  it.each([20, 30, 40])("advances once at a %i-point delta and wraps", (batchPercent) => {
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

  it("uses a delta from the baseline rather than an absolute percentage", () => {
    const a = entry("a", 20);
    const b = entry("b", 0);
    selector.select([a, b], 30);

    a.cachedQuota = quota(30);
    expect(selector.select([a, b], 30)).toBe(a);
    a.cachedQuota = quota(50);
    expect(selector.select([a, b], 30)).toBe(b);
  });

  it("keeps the current account when quota is unknown", () => {
    const a = entry("a", null);
    const b = entry("b", 0);
    expect(selector.select([a, b], 30)).toBe(a);
    expect(selector.select([a, b], 30)).toBe(a);
    expect(store.state?.baselineUsedPercent).toBeNull();
  });

  it.each([
    ["usage decrease", quota(10)],
    ["window reset", quota(45, null, 9999)],
    ["meter change", quota(45, 7)],
  ])("re-baselines on %s", (_label, changedQuota) => {
    const a = entry("a", 40);
    const b = entry("b", 0);
    selector.select([a, b], 30);
    a.cachedQuota = changedQuota;

    expect(selector.select([a, b], 30)).toBe(a);
    expect(store.state?.baselineUsedPercent).toBe(effectiveQuotaMeter(a)?.usedPercent ?? null);
  });

  it("re-baselines when the configured percentage changes", () => {
    const a = entry("a", 10);
    const b = entry("b", 0);
    selector.select([a, b], 20);
    a.cachedQuota = quota(30);

    expect(selector.select([a, b], 40)).toBe(a);
    expect(store.state).toMatchObject({ batchPercent: 40, baselineUsedPercent: 30 });
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
    expect(store.state?.baselineUsedPercent).toBe(30);
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

  it("fails open when persisted state is corrupt", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store.state = { version: 99 } as unknown as QuotaBatchCheckpoint;
    const fresh = new QuotaBatchSelector(store);
    const a = entry("a", 10);

    expect(fresh.select([a], 30)).toBe(a);
    expect(store.state).toMatchObject({ version: 1, currentEntryId: "a" });
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    { version: 1, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 10, meter: "primary", resetAt: 1000, token: "secret" },
    { version: 1, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: -1, meter: "primary", resetAt: 1000 },
    { version: 1, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 101, meter: "primary", resetAt: 1000 },
    { version: 1, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 10, meter: null, resetAt: null },
    { version: 1, strategy: "quota_batch", batchPercent: 30, currentEntryId: "a", baselineUsedPercent: 10, meter: "primary", resetAt: -1 },
  ])("rejects semantically invalid or credential-bearing checkpoints", (invalid) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store.state = invalid as unknown as QuotaBatchCheckpoint;
    const fresh = new QuotaBatchSelector(store);
    expect(fresh.select([entry("a", 25)], 30)).toBeDefined();
    expect(store.state).toMatchObject({ baselineUsedPercent: 25, meter: "primary" });
    expect(store.state).not.toHaveProperty("token");
  });

  it("clears persisted state on reset", () => {
    selector.select([entry("a", 10)], 30);
    selector.reset();
    expect(store.state).toBeNull();
  });
});
