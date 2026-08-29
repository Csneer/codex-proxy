import { describe, expect, it } from "vitest";
import {
  preserveLearnedLocks,
  resolveRefreshIntervals,
} from "@src/auth/active-quota-refresher.js";
import type { CodexQuota } from "@src/auth/types.js";

const NOW = Math.floor(Date.now() / 1000);

function quota(overrides: Partial<CodexQuota> = {}): CodexQuota {
  return {
    plan_type: "free",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 30,
      reset_at: NOW + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    ...overrides,
  };
}

describe("resolveRefreshIntervals", () => {
  it("uses historical defaults for unset and non-positive values", () => {
    for (const value of [undefined, null, 0, -1]) {
      expect(resolveRefreshIntervals(value)).toEqual({
        tickMs: 15 * 60_000,
        minGapMs: 30 * 60_000,
      });
    }
  });

  it("honors an explicitly configured interval", () => {
    expect(resolveRefreshIntervals(10)).toEqual({
      tickMs: 10 * 60_000,
      minGapMs: 10 * 60_000,
    });
  });
});

describe("preserveLearnedLocks", () => {
  it("keeps a future primary lock when usage reports available", () => {
    const existing = quota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: NOW + 3600,
        limit_window_seconds: 3600,
      },
    });
    const fresh = quota({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: 40,
        reset_at: null,
        limit_window_seconds: null,
      },
    });

    const merged = preserveLearnedLocks(existing, fresh);
    expect(merged.rate_limit).toMatchObject({
      allowed: false,
      limit_reached: true,
      used_percent: 100,
      reset_at: existing.rate_limit.reset_at,
    });
  });

  it("unlocks once the learned reset time has passed", () => {
    const existing = quota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: NOW - 60,
        limit_window_seconds: 3600,
      },
    });
    const fresh = quota({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: 40,
        reset_at: null,
        limit_window_seconds: null,
      },
    });

    expect(preserveLearnedLocks(existing, fresh).rate_limit.limit_reached).toBe(false);
  });

  it("keeps future secondary and code-review locks", () => {
    const existing = quota({
      secondary_rate_limit: {
        limit_reached: true,
        used_percent: 100,
        reset_at: NOW + 3600,
        limit_window_seconds: 3600,
      },
      code_review_rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: NOW + 7200,
        limit_window_seconds: 3600,
      },
    });
    const fresh = quota({
      secondary_rate_limit: {
        limit_reached: false,
        used_percent: 20,
        reset_at: null,
        limit_window_seconds: null,
      },
      code_review_rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: 20,
        reset_at: null,
        limit_window_seconds: null,
      },
    });

    const merged = preserveLearnedLocks(existing, fresh);
    expect(merged.secondary_rate_limit?.limit_reached).toBe(true);
    expect(merged.code_review_rate_limit?.limit_reached).toBe(true);
  });

  it("keeps a future per-model bucket lock", () => {
    const lockedBucket = {
      limit_id: "codex_bengalfox",
      limit_name: "codex_bengalfox",
      allowed: false,
      limit_reached: true,
      used_percent: 100,
      remaining_percent: 0,
      reset_at: NOW + 3600,
      limit_window_seconds: 3600,
      secondary_rate_limit: null,
    };
    const existing = quota({ rate_limits_by_limit_id: { codex_bengalfox: lockedBucket } });
    const fresh = quota({
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          ...lockedBucket,
          allowed: true,
          limit_reached: false,
          used_percent: 20,
          remaining_percent: 80,
          reset_at: null,
        },
      },
    });

    const merged = preserveLearnedLocks(existing, fresh);
    expect(merged.rate_limits_by_limit_id?.codex_bengalfox?.limit_reached).toBe(true);
    expect(merged.rate_limits_by_limit_id?.codex_bengalfox?.reset_at).toBe(lockedBucket.reset_at);
  });
});
