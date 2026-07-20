import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountQuotaProbeService } from "@src/services/account-quota-probe.js";
import type { AccountEntry, AccountStatus } from "@src/auth/types.js";
import type { CodexUsageResponse } from "@src/proxy/codex-api.js";

function usage(used = 20, secondary?: number, exhausted = false): CodexUsageResponse {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: !exhausted,
      limit_reached: exhausted,
      primary_window: {
        used_percent: used,
        reset_at: 2_000_000_000,
        limit_window_seconds: 18_000,
        reset_after_seconds: 100,
      },
      secondary_window: secondary === undefined ? null : {
        used_percent: secondary,
        reset_at: 2_000_000_000,
        limit_window_seconds: 604_800,
        reset_after_seconds: 100,
      },
    },
    code_review_rate_limit: null,
    credits: null,
    promo: null,
  };
}

function entry(status: AccountStatus = "disabled"): AccountEntry {
  return {
    id: "account-1",
    token: "secret-access-token",
    refreshToken: "secret-refresh-token",
    email: "hidden@example.test",
    accountId: "upstream-1",
    userId: "user-1",
    label: null,
    planType: "plus",
    proxyApiKey: "secret-proxy-key",
    status,
    usage: { request_count: 0, input_tokens: 0, output_tokens: 0, empty_response_count: 0, last_used: null },
    addedAt: new Date(0).toISOString(),
    cachedQuota: null,
    quotaFetchedAt: null,
  };
}

function codexError(status: number, body = "{}", message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status, body });
}

function harness(originalStatus: AccountStatus = "disabled") {
  let current = entry(originalStatus);
  const pool = {
    getEntry: vi.fn(() => current),
    updateCachedQuota: vi.fn(),
    updateToken: vi.fn((_id: string, token: string, refreshToken?: string) => {
      current = { ...current, token, refreshToken: refreshToken ?? current.refreshToken };
    }),
    readEntryRTFromDisk: vi.fn(() => current.refreshToken),
    markStatus: vi.fn(),
  };
  const deps = {
    getUsage: vi.fn(async () => usage()),
    refreshAccessToken: vi.fn(async () => ({ access_token: "rotated-access", refresh_token: "rotated-refresh" })),
    tryAcquireRefreshLock: vi.fn(() => true),
    releaseRefreshLock: vi.fn(),
    getProxyUrl: vi.fn(() => null),
    getLowQuotaUsedThreshold: vi.fn((kind: "primary" | "secondary") => kind === "secondary" ? 80 : 80),
  };
  return { pool, deps, service: new AccountQuotaProbeService(pool as never, deps), get current() { return current; } };
}

describe("AccountQuotaProbeService", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [usage(20), "available"],
    [usage(80), "quota_low"],
    [usage(10, 85), "quota_low"],
    [usage(100, undefined, true), "quota_exhausted"],
  ] as const)("classifies successful live quota as %s", async (liveUsage, expected) => {
    const h = harness();
    h.deps.getUsage.mockResolvedValue(liveUsage);
    const result = await h.service.probe("account-1");
    expect(result.probe_status).toBe(expected);
    expect(result).toMatchObject({ routing_status: "disabled", quota_source: "live", token_refreshed: false });
    expect(result).toHaveProperty("quota");
    expect(result).not.toHaveProperty("raw");
    expect(h.pool.updateCachedQuota).toHaveBeenCalledOnce();
    expect(h.current.status).toBe("disabled");
    expect(h.pool.markStatus).not.toHaveBeenCalled();
  });

  it.each([
    [codexError(402), "quota_exhausted"],
    [codexError(403, '{"error":"deactivated"}'), "account_banned"],
    [codexError(403, "<!doctype html><title>Just a moment</title>"), "upstream_blocked"],
    [codexError(403, "cf_chl challenge"), "upstream_blocked"],
    [new Error("TLS EOF while connecting"), "transient_network"],
    [new Error("request ETIMEDOUT"), "transient_network"],
    [new Error("socket ECONNRESET"), "transient_network"],
    [new Error("unexpected parser failure"), "unknown_failure"],
  ] as const)("classifies probe failures without changing disabled status", async (error, expected) => {
    const h = harness();
    h.deps.getUsage.mockRejectedValue(error);
    const result = await h.service.probe("account-1");
    expect(result.probe_status).toBe(expected);
    expect(h.current.status).toBe("disabled");
    expect(h.pool.markStatus).not.toHaveBeenCalled();
  });

  it("refreshes once under the shared lock after a confirmed 401 and retries usage once", async () => {
    const h = harness();
    h.deps.getUsage
      .mockRejectedValueOnce(codexError(401, '{"token":"secret-access-token"}'))
      .mockResolvedValueOnce(usage(30));

    const result = await h.service.probe("account-1");

    expect(result).toMatchObject({ probe_status: "available", token_refreshed: true, routing_status: "disabled" });
    expect(h.deps.tryAcquireRefreshLock).toHaveBeenCalledOnce();
    expect(h.deps.refreshAccessToken).toHaveBeenCalledOnce();
    expect(h.pool.updateToken).toHaveBeenCalledWith("account-1", "rotated-access", "rotated-refresh");
    expect(h.deps.getUsage).toHaveBeenCalledTimes(2);
    expect(h.deps.releaseRefreshLock).toHaveBeenCalledOnce();
    expect(h.current.status).toBe("disabled");
  });

  it("does not consume a refresh token when the lock is held elsewhere", async () => {
    const h = harness();
    h.deps.getUsage.mockRejectedValue(codexError(401));
    h.deps.tryAcquireRefreshLock.mockReturnValue(false);
    const result = await h.service.probe("account-1");
    expect(result.probe_status).toBe("token_invalid");
    expect(h.deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(h.deps.releaseRefreshLock).not.toHaveBeenCalled();
  });

  it("rechecks the latest refresh token after locking", async () => {
    const h = harness();
    h.deps.getUsage.mockRejectedValue(codexError(401));
    h.pool.readEntryRTFromDisk.mockReturnValue("newer-disk-refresh");
    await h.service.probe("account-1");
    expect(h.deps.refreshAccessToken).toHaveBeenCalledWith("newer-disk-refresh", null);
  });

  it("releases the lock and preserves disabled when refresh fails", async () => {
    const h = harness();
    h.deps.getUsage.mockRejectedValue(codexError(401));
    h.deps.refreshAccessToken.mockRejectedValue(new Error("invalid_grant secret-refresh-token"));
    const result = await h.service.probe("account-1");
    expect(result.probe_status).toBe("token_invalid");
    expect(result.detail).not.toContain("secret-refresh-token");
    expect(h.deps.releaseRefreshLock).toHaveBeenCalledOnce();
    expect(h.current.status).toBe("disabled");
  });

  it("bounds and redacts error detail", async () => {
    const h = harness();
    h.deps.getUsage.mockRejectedValue(new Error(`secret-access-token secret-refresh-token ${"x".repeat(1000)}`));
    const result = await h.service.probe("account-1");
    expect(result.detail?.length).toBeLessThanOrEqual(256);
    expect(result.detail).not.toContain("secret-access-token");
    expect(result.detail).not.toContain("secret-refresh-token");
  });

  it("never schedules normal token refresh or mutates routing status", async () => {
    const h = harness();
    await h.service.probe("account-1");
    expect(h.pool).not.toHaveProperty("scheduleOne");
    expect(h.pool.markStatus).not.toHaveBeenCalled();
  });
});
