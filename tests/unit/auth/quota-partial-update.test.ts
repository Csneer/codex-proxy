import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { resetConfigForTesting, setConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import type { CodexQuota } from "@src/auth/types.js";
import { applyParsedRateLimits, applyRateLimitHeaders } from "@src/routes/shared/proxy-rate-limit.js";

const SPARK = "gpt-5.3-codex-spark";
const NOW = Date.parse("2026-09-05T10:00:00Z");

function snapshot(sparkUsed = 37): CodexQuota {
  const window = (used: number, seconds: number) => ({
    allowed: true,
    limit_reached: false,
    used_percent: used,
    reset_at: NOW / 1000 + seconds,
    limit_window_seconds: seconds,
  });
  return {
    plan_type: "plus",
    rate_limit: window(17, 18_000),
    secondary_rate_limit: window(47, 604_800),
    code_review_rate_limit: window(5, 604_800),
    rate_limits_by_limit_id: {
      codex_bengalfox: {
        ...window(sparkUsed, 604_800),
        limit_id: "codex_bengalfox",
        limit_name: "Spark",
      },
    },
  };
}

describe("quota snapshots and passive response updates", () => {
  let pool: AccountPool;
  let a: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setConfigForTesting(createMockConfig({
      auth: { rotation_strategy: "quota_batch", quota_batch_percent: 10 },
      quota: { refresh_interval_minutes: 1, skip_exhausted: true },
    }));
    pool = new AccountPool({
      persistence: createMemoryPersistence(),
      quotaBatchStateStore: { load: () => null, save: () => {}, clear: () => {} },
    });
    a = pool.addAccount(createValidJwt({ accountId: "partial-a", planType: "plus" }));
    pool.updateCachedQuota(a, snapshot());
  });

  afterEach(() => {
    pool.destroy();
    resetConfigForTesting();
    vi.useRealTimers();
  });

  function primaryHeaders(used = 18): void {
    applyRateLimitHeaders({
      accountPool: pool, entryId: a,
      headers: new Headers({ "x-codex-primary-used-percent": String(used) }),
    });
  }

  it("keeps the Spark absolute boundary after a generic response header update", () => {
    const b = pool.addAccount(createValidJwt({ accountId: "partial-b", planType: "plus" }));
    pool.updateCachedQuota(b, snapshot(0));
    expect(pool.acquire({ model: SPARK })?.entryId).toBe(a);
    pool.releaseWithoutCounting(a);

    primaryHeaders(40);
    expect(pool.getEntry(a)?.cachedQuota?.rate_limits_by_limit_id?.codex_bengalfox.used_percent).toBe(37);
    expect(pool.acquire({ model: SPARK })?.entryId).toBe(a);
    pool.releaseWithoutCounting(a);

    pool.updateCachedQuota(a, snapshot(40));
    expect(pool.acquire({ model: SPARK })?.entryId).toBe(b);
  });

  it("preserves unreported windows and their metadata instead of erasing them", () => {
    const original = snapshot();
    primaryHeaders(19);
    const cached = pool.getEntry(a)!.cachedQuota!;
    expect(cached.rate_limit).toMatchObject({
      used_percent: 19, reset_at: original.rate_limit.reset_at, limit_window_seconds: 18_000,
    });
    expect(cached.secondary_rate_limit).toEqual(original.secondary_rate_limit);
    expect(cached.code_review_rate_limit).toEqual(original.code_review_rate_limit);
    expect(cached.rate_limits_by_limit_id).toEqual(original.rate_limits_by_limit_id);
    applyParsedRateLimits({
      accountPool: pool, entryId: a,
      rateLimits: { primary: null, secondary: null, code_review: {
        primary: { used_percent: 8, reset_at: null, window_minutes: null }, secondary: null,
      } },
    });
    expect(pool.getEntry(a)?.cachedQuota?.rate_limit).toEqual(cached.rate_limit);
    expect(pool.getEntry(a)?.cachedQuota?.code_review_rate_limit?.used_percent).toBe(8);
  });

  it.each(["primary", "model"])('does not clear a live %s 429 lock with another in-flight response', (kind) => {
    if (kind === "primary") pool.applyRateLimit429(a, { retryAfterSec: 120 });
    else pool.applyAdditionalRateLimit429(a, "codex_bengalfox", { retryAfterSec: 120 });
    primaryHeaders(18);
    expect(pool.acquire({ model: SPARK })).toBeNull();
    if (kind === "model") expect(pool.acquire({ model: "gpt-5.4" })?.entryId).toBe(a);
  });

  it("allows a complete snapshot to replace or remove model-specific windows", () => {
    pool.applyAdditionalRateLimit429(a, "codex_bengalfox", { retryAfterSec: 120 });
    pool.updateCachedQuota(a, { ...snapshot(), rate_limits_by_limit_id: null });
    expect(pool.getEntry(a)?.cachedQuota?.rate_limits_by_limit_id).toBeNull();
    expect(pool.acquire({ model: SPARK })?.entryId).toBe(a);
    expect(pool.getEntry(a)?.quotaFetchedAtByMeter).not.toHaveProperty("codex_bengalfox:primary");
  });

  it("does not freshen stale model telemetry when only the generic window updates", () => {
    const b = pool.addAccount(createValidJwt({ accountId: "partial-b", planType: "plus" }));
    pool.updateCachedQuota(b, snapshot(0));
    expect(pool.acquire({ model: SPARK })?.entryId).toBe(a);
    pool.releaseWithoutCounting(a);
    vi.setSystemTime(NOW + 120_001);
    primaryHeaders(19);
    const fetched = pool.getEntry(a)?.quotaFetchedAtByMeter;
    expect(fetched?.primary).toBe(new Date(NOW + 120_001).toISOString());
    expect(fetched?.["codex_bengalfox:primary"]).toBe(new Date(NOW).toISOString());
    expect(pool.acquire({ model: SPARK })?.entryId).toBe(b);
  });

  it("does not label an unreported generic window fresh from a review-only event", () => {
    vi.setSystemTime(NOW + 120_001);
    applyParsedRateLimits({
      accountPool: pool, entryId: a,
      rateLimits: { primary: null, secondary: null, code_review: {
        primary: { used_percent: 8, reset_at: null, window_minutes: null }, secondary: null,
      } },
    });
    expect(pool.getEntry(a)?.quotaFetchedAtByMeter?.primary).toBe(new Date(NOW).toISOString());
  });

  it.each([false, true])("deep-merges a model partial without losing other windows or locks (locked=%s)", (locked) => {
    const current = pool.getEntry(a)!.cachedQuota!;
    const modelBucket = current.rate_limits_by_limit_id!.codex_bengalfox;
    const secondary = {
      used_percent: 3,
      reset_at: NOW / 1000 + 2_592_000,
      limit_window_seconds: 2_592_000,
      limit_reached: false,
    };
    modelBucket.secondary_rate_limit = secondary;
    current.rate_limits_by_limit_id!.another_model = { ...modelBucket, limit_id: "another_model" };
    if (locked) pool.applyAdditionalRateLimit429(a, "codex_bengalfox", { retryAfterSec: 120 });
    pool.updateCachedQuota(a, {
      ...current,
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          ...modelBucket,
          used_percent: 39,
          reset_at: null,
          limit_window_seconds: null,
          secondary_rate_limit: null,
        },
      },
    }, { partial: true });
    const merged = pool.getEntry(a)!.cachedQuota!.rate_limits_by_limit_id!.codex_bengalfox;
    expect(merged).toMatchObject({
      used_percent: locked ? 100 : 39,
      limit_reached: locked,
      reset_at: modelBucket.reset_at,
      limit_window_seconds: modelBucket.limit_window_seconds,
      secondary_rate_limit: secondary,
    });
    expect(pool.getEntry(a)?.cachedQuota?.rate_limits_by_limit_id?.another_model).toEqual(
      current.rate_limits_by_limit_id!.another_model,
    );
  });

  it("uses a fresh longer applicable window when the shorter window becomes stale", () => {
    const b = pool.addAccount(createValidJwt({ accountId: "partial-b", planType: "plus" }));
    pool.updateCachedQuota(b, snapshot(0));
    expect(pool.acquire()?.entryId).toBe(a);
    pool.releaseWithoutCounting(a);
    vi.setSystemTime(NOW + 120_001);
    const secondaryUpdate = (used: number) => applyParsedRateLimits({
      accountPool: pool, entryId: a,
      rateLimits: { primary: null, secondary: { used_percent: used, reset_at: null, window_minutes: null } },
    });
    secondaryUpdate(47);
    expect(pool.acquire()?.entryId).toBe(a);
    pool.releaseWithoutCounting(a);
    secondaryUpdate(50);
    expect(pool.acquire()?.entryId).toBe(b);
  });

  it("preserves the original age of legacy windows when their first partial update arrives", () => {
    delete pool.getEntry(a)!.quotaFetchedAtByMeter;
    vi.setSystemTime(NOW + 120_001);
    primaryHeaders(19);
    expect(pool.getEntry(a)?.quotaFetchedAtByMeter).toMatchObject({
      primary: new Date(NOW + 120_001).toISOString(),
      secondary: new Date(NOW).toISOString(),
      "codex_bengalfox:primary": new Date(NOW).toISOString(),
    });
  });
});
