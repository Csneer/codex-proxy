/**
 * Regression coverage for 429 handling with multiple in-flight slots.
 * A passive quota update must not release requests that are still running;
 * a counted failed attempt releases only its own already-counted slot.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import type { CodexQuota } from "@src/auth/types.js";

const SPARK_MODEL = "gpt-5.3-codex-spark";

function makePool(): { pool: AccountPool; entryId: string } {
  setConfigForTesting(createMockConfig({
    auth: { max_concurrent_per_account: 3 },
    quota: { skip_exhausted: true },
  }));
  const pool = new AccountPool({ persistence: createMemoryPersistence() });
  return { pool, entryId: pool.addAccount(createValidJwt({ accountId: "429-concurrency" })) };
}

function recoveredQuota(additional = false): CodexQuota {
  const quota: CodexQuota = {
    plan_type: "free",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 10,
      reset_at: Math.floor(Date.now() / 1000) + 7200,
      limit_window_seconds: 18000,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
  };
  if (additional) {
    quota.rate_limits_by_limit_id = {
      codex_bengalfox: {
        limit_id: "codex_bengalfox",
        limit_name: "Codex Spark",
        allowed: true,
        limit_reached: false,
        used_percent: 10,
        remaining_percent: 90,
        reset_at: Math.floor(Date.now() / 1000) + 7200,
        limit_window_seconds: 3600,
        secondary_rate_limit: null,
      },
    };
  }
  return quota;
}

function holdThreeSlots(pool: AccountPool, model?: string): { entryId: string; leaseId: string }[] {
  const acquired = [pool.acquire({ model }), pool.acquire({ model }), pool.acquire({ model })];
  expect(acquired.every(Boolean)).toBe(true);
  expect(pool.acquire({ model })).toBeNull();
  return acquired.map((item) => {
    if (!item?.leaseId) throw new Error("Real acquisitions must provide a lease");
    return { entryId: item.entryId, leaseId: item.leaseId };
  });
}

describe("429 handling preserves concurrent account slots", () => {
  afterEach(() => resetConfigForTesting());

  it.each([
    ["general", false],
    ["additional", true],
  ])("passive %s 429 preserves all three slots through quota recovery", (_name, additional) => {
    const { pool } = makePool();
    const model = additional ? SPARK_MODEL : undefined;
    const acquired = holdThreeSlots(pool, model);
    const entryId = acquired[0].entryId;

    if (additional) {
      pool.applyAdditionalRateLimit429(entryId, "codex_bengalfox", { resetsAtSec: Math.floor(Date.now() / 1000) + 60 });
    } else {
      pool.applyRateLimit429(entryId, { resetsAtSec: Math.floor(Date.now() / 1000) + 60 });
    }
    pool.updateCachedQuota(entryId, recoveredQuota(additional));

    expect(pool.acquire({ model })).toBeNull();
  });

  it.each([
    ["general", false],
    ["additional", true],
  ])("counted %s 429 releases one slot while siblings remain after recovery", (_name, additional) => {
    const { pool } = makePool();
    const model = additional ? SPARK_MODEL : undefined;
    const acquired = holdThreeSlots(pool, model);
    const entryId = acquired[0].entryId;

    if (additional) {
      pool.applyAdditionalRateLimit429(entryId, "codex_bengalfox", { resetsAtSec: Math.floor(Date.now() / 1000) + 60, countRequest: true, leaseId: acquired[1].leaseId });
    } else {
      pool.applyRateLimit429(entryId, { resetsAtSec: Math.floor(Date.now() / 1000) + 60, countRequest: true, leaseId: acquired[1].leaseId });
    }
    pool.updateCachedQuota(entryId, recoveredQuota(additional));
    // The counted 429 already released this exact lease; a late duplicate
    // completion for the same lease must not consume either sibling slot.
    pool.releaseWithoutCounting(entryId, acquired[1].leaseId);
    expect(pool.getCapacitySummary()).toMatchObject({ used_slots: 2, available_slots: 1 });

    expect(pool.acquire({ model })).not.toBeNull();
    expect(pool.acquire({ model })).toBeNull();
  });
});
