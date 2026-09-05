/**
 * Tests for sticky rotation strategy in AccountPool.
 *
 * Sticky: prefer the most recently used account, keeping it in use
 * until rate-limited or quota-exhausted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createMockConfig } from "@helpers/config.js";
import { createValidJwt } from "@helpers/jwt.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { getModelPlanTypes } from "@src/models/model-store.js";
import type { CodexQuota } from "@src/auth/types.js";
import type { QuotaBatchCheckpoint, QuotaBatchStateStore } from "@src/auth/quota-batch-selector.js";

// Only model-store needs mocking (for model-aware selection test)
vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
  getModelInfo: vi.fn(() => null),
  parseModelName: vi.fn((m: string) => ({ modelId: m, serviceTier: null, reasoningEffort: null })),
}));

describe("account-pool sticky strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfigForTesting(createMockConfig({ auth: { rotation_strategy: "sticky" } }));
  });
  afterEach(() => {
    resetConfigForTesting();
  });

  it("selects account with most recent last_used", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idA = pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));
    const idC = pool.addAccount(createValidJwt({ accountId: "c", email: "c@test.com", planType: "free" }));

    // Simulate: B was used most recently, then A, then C
    pool.getEntry(idC)!.usage.last_used = new Date(Date.now() - 30_000).toISOString();
    pool.getEntry(idC)!.usage.request_count = 1;

    pool.getEntry(idA)!.usage.last_used = new Date(Date.now() - 10_000).toISOString();
    pool.getEntry(idA)!.usage.request_count = 2;

    pool.getEntry(idB)!.usage.last_used = new Date(Date.now() - 1_000).toISOString();
    pool.getEntry(idB)!.usage.request_count = 5;

    // Sticky should pick B (most recent last_used) despite having most requests
    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });

  it("sticks to same account across multiple acquire/release cycles", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));

    // First acquire picks one (arbitrary from fresh pool)
    const first = pool.acquire()!;
    pool.release(first.entryId);

    // Subsequent acquires should stick to the same account
    for (let i = 0; i < 5; i++) {
      const next = pool.acquire()!;
      expect(next.entryId).toBe(first.entryId);
      pool.release(next.entryId);
    }
  });

  it("falls back when current account is rate-limited", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idA = pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));

    // Make A the sticky choice
    pool.getEntry(idA)!.usage.last_used = new Date().toISOString();
    pool.getEntry(idA)!.usage.request_count = 5;

    // Rate-limit A
    pool.applyRateLimit429(idA, { retryAfterSec: 300 });

    // Should fall back to B
    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });

  it("picks first available when no account has been used yet", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));
    pool.addAccount(createValidJwt({ accountId: "c", email: "c@test.com", planType: "free" }));

    // All accounts have null last_used — should pick one
    const first = pool.acquire();
    expect(first).not.toBeNull();
    pool.release(first!.entryId);

    // After releasing, the same one should be sticky
    const second = pool.acquire();
    expect(second).not.toBeNull();
    expect(second!.entryId).toBe(first!.entryId);
    pool.release(second!.entryId);
  });

  it("respects model filtering", () => {
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);

    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idFree = pool.addAccount(createValidJwt({ accountId: "free1", email: "free@test.com", planType: "free" }));
    const idTeam = pool.addAccount(createValidJwt({ accountId: "team1", email: "team@test.com", planType: "team" }));

    // Use the free account more recently
    pool.getEntry(idFree)!.usage.last_used = new Date().toISOString();
    pool.getEntry(idFree)!.usage.request_count = 10;

    // Model requires team plan — sticky should pick team account despite free being more recent
    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idTeam);
    pool.release(acquired!.entryId);
  });

  it("least_used still works (regression guard)", () => {
    setConfigForTesting(createMockConfig({ auth: { rotation_strategy: "least_used" } }));

    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idA = pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));

    // A has more requests — least_used should prefer B
    pool.getEntry(idA)!.usage.request_count = 10;
    pool.getEntry(idA)!.usage.last_used = new Date().toISOString();
    pool.getEntry(idB)!.usage.request_count = 2;

    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });
});

class MemoryQuotaBatchStore implements QuotaBatchStateStore {
  state: QuotaBatchCheckpoint | null = null;
  load(): QuotaBatchCheckpoint | null { return this.state; }
  save(state: QuotaBatchCheckpoint): void { this.state = structuredClone(state); }
  clear(): void { this.state = null; }
}

function quota(usedPercent: number, options?: { secondary?: number; exhausted?: boolean; windowSeconds?: number }): CodexQuota {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: options?.exhausted !== true,
      limit_reached: options?.exhausted === true,
      used_percent: usedPercent,
      reset_at: nowSec + (options?.windowSeconds ?? 18_000),
      limit_window_seconds: options?.windowSeconds ?? 18_000,
    },
    secondary_rate_limit: options?.secondary === undefined ? null : {
      limit_reached: false,
      used_percent: options.secondary,
      reset_at: nowSec + 604_800,
      limit_window_seconds: 604_800,
    },
    code_review_rate_limit: null,
  };
}

describe("account-pool quota_batch strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfigForTesting(createMockConfig({
      auth: { rotation_strategy: "quota_batch", quota_batch_percent: 30 },
    }));
  });

  afterEach(() => resetConfigForTesting());

  function createPool(): AccountPool {
    return new AccountPool({
      persistence: createMemoryPersistence(),
      quotaBatchStateStore: new MemoryQuotaBatchStore(),
    });
  }

  it("keeps an account until its shortest actual window crosses the absolute bucket", () => {
    setConfigForTesting(createMockConfig({
      auth: { rotation_strategy: "quota_batch", quota_batch_percent: 10 },
    }));
    const pool = createPool();
    const idA = pool.addAccount(createValidJwt({ accountId: "qb-a", planType: "plus" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "qb-b", planType: "plus" }));
    pool.updateCachedQuota(idA, quota(37, { secondary: 12 }));
    pool.updateCachedQuota(idB, quota(0, { secondary: 5 }));

    const first = pool.acquire()!;
    pool.release(first.entryId);
    expect(first.entryId).toBe(idA);
    pool.updateCachedQuota(idA, quota(39, { secondary: 41 }));
    const below = pool.acquire()!;
    pool.release(below.entryId);
    expect(below.entryId).toBe(idA);
    pool.updateCachedQuota(idA, quota(40, { secondary: 42 }));
    const switched = pool.acquire()!;
    pool.release(switched.entryId);
    expect(switched.entryId).toBe(idB);
  });

  it("does not rotate merely because request count grows when quota does not move", () => {
    setConfigForTesting(createMockConfig({
      auth: { rotation_strategy: "quota_batch", quota_batch_percent: 10 },
    }));
    const pool = createPool();
    const idA = pool.addAccount(createValidJwt({ accountId: "qb-even-a", planType: "plus" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "qb-even-b", planType: "plus" }));
    pool.updateCachedQuota(idA, quota(10));
    pool.updateCachedQuota(idB, quota(10));

    const first = pool.acquire()!;
    pool.release(first.entryId);
    pool.getEntry(idA)!.usage.request_count = 100;
    const stillCurrent = pool.acquire()!;
    pool.release(stillCurrent.entryId);
    expect(first.entryId).toBe(idA);
    expect(stillCurrent.entryId).toBe(idA);
  });

  it("overrides stale conversation affinity", () => {
    const pool = createPool();
    const idA = pool.addAccount(createValidJwt({ accountId: "qb-aff-a", planType: "plus" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "qb-aff-b", planType: "plus" }));
    pool.updateCachedQuota(idA, quota(10));
    pool.updateCachedQuota(idB, quota(10));
    const first = pool.acquire({ preferredEntryId: idB })!;
    pool.release(first.entryId);
    expect(first.entryId).toBe(idA);
    pool.updateCachedQuota(idA, quota(40));
    const switched = pool.acquire({ preferredEntryId: idA })!;
    pool.release(switched.entryId);
    expect(switched.entryId).toBe(idB);
  });

  it("filters retry exclusions, disabled, exhaustion, and concurrency first", () => {
    setConfigForTesting(createMockConfig({
      auth: { rotation_strategy: "quota_batch", quota_batch_percent: 30, max_concurrent_per_account: 1 },
      quota: { skip_exhausted: true },
    }));
    const pool = createPool();
    const idA = pool.addAccount(createValidJwt({ accountId: "qb-filter-a", planType: "plus" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "qb-filter-b", planType: "plus" }));
    const idC = pool.addAccount(createValidJwt({ accountId: "qb-filter-c", planType: "plus" }));
    pool.updateCachedQuota(idA, quota(10));
    pool.updateCachedQuota(idB, quota(20));
    pool.updateCachedQuota(idC, quota(30));

    const first = pool.acquire()!;
    const concurrencyFallback = pool.acquire()!;
    expect([first.entryId, concurrencyFallback.entryId]).toEqual([idA, idB]);
    pool.releaseWithoutCounting(first.entryId);
    pool.releaseWithoutCounting(concurrencyFallback.entryId);
    pool.markStatus(idB, "disabled");
    const excluded = pool.acquire({ excludeIds: [idA] })!;
    expect(excluded.entryId).toBe(idC);
    pool.release(excluded.entryId);
    pool.updateCachedQuota(idC, quota(100, { exhausted: true }));
    expect(pool.acquire({ excludeIds: [idA] })).toBeNull();
  });

  it("applies model and tier filters before quota batching", () => {
    vi.mocked(getModelPlanTypes).mockReturnValue(["team", "plus"]);
    setConfigForTesting(createMockConfig({
      auth: { rotation_strategy: "quota_batch", quota_batch_percent: 30, tier_priority: ["team", "plus"] },
    }));
    const pool = createPool();
    const plus = pool.addAccount(createValidJwt({ accountId: "qb-plus", planType: "plus" }));
    const team = pool.addAccount(createValidJwt({ accountId: "qb-team", planType: "team" }));
    pool.updateCachedQuota(plus, quota(10));
    pool.updateCachedQuota(team, quota(10));
    const acquired = pool.acquire({ model: "gpt-5.4" })!;
    expect(acquired.entryId).toBe(team);
    pool.release(acquired.entryId);
  });

  it("does not let model catalog selection advance the request batch", () => {
    const pool = createPool();
    const idA = pool.addAccount(createValidJwt({ accountId: "qb-model-a", planType: "plus" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "qb-model-b", planType: "plus" }));
    pool.updateCachedQuota(idA, quota(10));
    pool.updateCachedQuota(idB, quota(20));
    const first = pool.acquire()!;
    pool.release(first.entryId);
    pool.getDistinctPlanAccounts().forEach((account) => pool.releaseWithoutCounting(account.entryId));
    pool.updateCachedQuota(idA, quota(40));
    const next = pool.acquire()!;
    expect(next.entryId).toBe(idB);
    pool.release(next.entryId);
  });

  it("approximately balances consumed quota in batches across mixed real windows and request costs", () => {
    setConfigForTesting(createMockConfig({ auth: { rotation_strategy: "quota_batch", quota_batch_percent: 10 } }));
    const pool = createPool();
    const windows = [18_000, 604_800, 2_592_000];
    const initial = [7, 2, 3];
    const costs = [1, 2, 3];
    const ids = windows.map((_, i) => pool.addAccount(createValidJwt({ accountId: "mixed-window-" + i })));
    const used = [...initial];
    const requests = [0, 0, 0];
    ids.forEach((id, i) => pool.updateCachedQuota(id, quota(used[i], { windowSeconds: windows[i] })));
    for (let round = 0; round < 6; round++) {
      ids.forEach((id, i) => {
        const boundary = (Math.floor(used[i] / 10) + 1) * 10;
        while (used[i] < boundary) {
          const acquired = pool.acquire()!;
          expect(acquired.entryId).toBe(id);
          used[i] += costs[i];
          requests[i]++;
          pool.updateCachedQuota(id, quota(used[i], { windowSeconds: windows[i] }));
          pool.release(id);
        }
      });
    }
    const consumed = used.map((value, i) => value - initial[i]);
    expect(Math.max(...consumed) - Math.min(...consumed)).toBeLessThanOrEqual(10);
    expect(requests[0]).toBeGreaterThan(requests[1]);
    expect(requests[1]).toBeGreaterThan(requests[2]);
  });

  it("hands off new requests at a boundary while old requests retain their slots", async () => {
    setConfigForTesting(createMockConfig({
      auth: { rotation_strategy: "quota_batch", quota_batch_percent: 10, max_concurrent_per_account: 3 },
    }));
    const pool = createPool();
    const a = pool.addAccount(createValidJwt({ accountId: "held-a" }));
    const b = pool.addAccount(createValidJwt({ accountId: "held-b" }));
    pool.updateCachedQuota(a, quota(37));
    pool.updateCachedQuota(b, quota(7));
    const held = await Promise.all([Promise.resolve().then(() => pool.acquire()), Promise.resolve().then(() => pool.acquire())]);
    expect(held.map((item) => item!.entryId)).toEqual([a, a]);
    pool.updateCachedQuota(a, quota(40));
    expect(pool.acquire()!.entryId).toBe(b);
    expect(pool.getCapacitySummary().used_slots).toBe(3);
    pool.releaseWithoutCounting(a);
    pool.updateCachedQuota(a, quota(46));
    expect(pool.acquire()!.entryId).toBe(b);
    pool.releaseWithoutCounting(a);
    pool.releaseWithoutCounting(b);
    pool.releaseWithoutCounting(b);
    expect(pool.getCapacitySummary().used_slots).toBe(0);
  });
});
