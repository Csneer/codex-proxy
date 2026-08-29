import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { AccountInfo, CodexQuota } from "@src/auth/types.js";
import { createQuotaSummaryRoutes } from "@src/routes/quota-summary.js";

function quota(
  primaryRemaining: number | null,
  secondaryRemaining: number | null,
  secondaryWindowSeconds = 604_800,
): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: primaryRemaining === 0,
      used_percent: primaryRemaining === null ? null : 100 - primaryRemaining,
      remaining_percent: primaryRemaining,
      reset_at: 1_800_000_000,
      limit_window_seconds: 18_000,
    },
    secondary_rate_limit: secondaryRemaining === null ? null : {
      limit_reached: secondaryRemaining === 0,
      used_percent: 100 - secondaryRemaining,
      remaining_percent: secondaryRemaining,
      reset_at: 1_800_500_000,
      limit_window_seconds: secondaryWindowSeconds,
    },
    code_review_rate_limit: null,
  };
}

function account(id: string, status: AccountInfo["status"], cachedQuota?: CodexQuota): AccountInfo {
  return {
    id,
    email: null,
    accountId: null,
    userId: null,
    label: null,
    planType: "plus",
    status,
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
    },
    addedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    quota: cachedQuota,
    quotaFetchedAt: cachedQuota ? `2026-08-${id === "a" ? "01" : "02"}T00:00:00.000Z` : null,
  };
}

function appFor(accounts: AccountInfo[], clientIp = "172.16.100.20"): Hono {
  const pool = { getAccounts: () => accounts } as unknown as AccountPool;
  const app = new Hono();
  app.route("/", createQuotaSummaryRoutes(pool, {
    resolveClientIp: () => clientIp,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
  }));
  return app;
}

describe("GET /api/quota-summary", () => {
  it("totals cached five-hour and weekly quota for active accounts only", async () => {
    const app = appFor([
      account("a", "active", quota(80, 60)),
      account("b", "active", quota(20, 25, 2_592_000)),
      account("c", "active"),
      account("d", "disabled", quota(100, 100)),
    ]);

    const response = await app.request("/api/quota-summary");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      generated_at: "2026-08-30T12:00:00.000Z",
      source: "cached",
      active_accounts: 3,
      accounts_with_cached_quota: 2,
      accounts_without_cached_quota: 1,
      oldest_quota_fetched_at: "2026-08-01T00:00:00.000Z",
      newest_quota_fetched_at: "2026-08-02T00:00:00.000Z",
      windows: {
        five_hour: {
          window_seconds: 18_000,
          source_windows: ["primary_rate_limit"],
          reported_accounts: 2,
          missing_accounts: 1,
          exhausted_accounts: 0,
          remaining_percent_total: 100,
          remaining_percent_average: 50,
          earliest_reset_at: 1_800_000_000,
          latest_reset_at: 1_800_000_000,
        },
        seven_day: {
          window_seconds: 604_800,
          source_windows: ["secondary_rate_limit"],
          reported_accounts: 1,
          missing_accounts: 2,
          exhausted_accounts: 0,
          remaining_percent_total: 60,
          remaining_percent_average: 60,
          earliest_reset_at: 1_800_500_000,
          latest_reset_at: 1_800_500_000,
        },
        thirty_day: {
          window_seconds: 2_592_000,
          source_windows: ["secondary_rate_limit"],
          reported_accounts: 1,
          missing_accounts: 2,
          exhausted_accounts: 0,
          remaining_percent_total: 25,
          remaining_percent_average: 25,
          earliest_reset_at: 1_800_500_000,
          latest_reset_at: 1_800_500_000,
        },
        other: [],
      },
    });
  });

  it("falls back to used_percent when remaining_percent is absent", async () => {
    const legacyQuota = quota(75, null);
    delete legacyQuota.rate_limit.remaining_percent;
    const response = await appFor([account("a", "active", legacyQuota)]).request("/api/quota-summary");
    const body = await response.json();
    expect(body.windows.five_hour.remaining_percent_total).toBe(75);
  });

  it("returns a stable empty summary", async () => {
    const response = await appFor([account("d", "disabled", quota(100, 100))]).request("/api/quota-summary");
    const body = await response.json();
    expect(body.active_accounts).toBe(0);
    expect(body.windows.five_hour.remaining_percent_total).toBe(0);
    expect(body.windows.five_hour.remaining_percent_average).toBeNull();
    expect(body.windows.seven_day.reported_accounts).toBe(0);
    expect(body.windows.thirty_day.reported_accounts).toBe(0);
  });

  it("keeps non-standard and unknown-duration windows separate", async () => {
    const twoDay = quota(50, 40, 172_800);
    const unknown = quota(25, 30, 0);
    unknown.secondary_rate_limit!.limit_window_seconds = null;
    const response = await appFor([
      account("a", "active", twoDay),
      account("b", "active", unknown),
    ]).request("/api/quota-summary");
    const body = await response.json();
    expect(body.windows.other).toMatchObject([
      { window_seconds: 172_800, remaining_percent_total: 40, reported_accounts: 1 },
      { window_seconds: null, remaining_percent_total: 30, reported_accounts: 1 },
    ]);
  });

  it("rejects callers outside private networks", async () => {
    const response = await appFor([], "8.8.8.8").request("/api/quota-summary");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "LAN access required" });
  });
});
