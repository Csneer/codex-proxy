import type { AccountPool } from "../auth/account-pool.js";
import { releaseRefreshLock, tryAcquireRefreshLock } from "../auth/refresh-lock.js";
import { refreshAccessToken } from "../auth/oauth-pkce.js";
import { toQuota } from "../auth/quota-utils.js";
import type { AccountStatus, CodexQuota } from "../auth/types.js";
import { getConfig } from "../config.js";
import type { CodexUsageResponse } from "../proxy/codex-api.js";
import {
  isBanError,
  isCfChallengeError,
  isCfPathBlockError,
  isQuotaExhaustedError,
  isTokenInvalidError,
} from "../proxy/error-classification.js";

export type AccountProbeStatus =
  | "available"
  | "quota_low"
  | "quota_exhausted"
  | "token_invalid"
  | "account_banned"
  | "transient_network"
  | "upstream_blocked"
  | "unknown_failure";

export interface AccountQuotaProbeResult {
  routing_status: AccountStatus;
  probe_status: AccountProbeStatus;
  quota_source: "live";
  token_refreshed: boolean;
  quota?: CodexQuota;
  detail?: string;
}

interface ProbePool {
  getEntry: AccountPool["getEntry"];
  updateCachedQuota: AccountPool["updateCachedQuota"];
  updateToken: AccountPool["updateToken"];
  readEntryRTFromDisk?: AccountPool["readEntryRTFromDisk"];
}

interface ProbeDependencies {
  getUsage(token: string, accountId: string | null, entryId: string, proxyUrl: string | null): Promise<CodexUsageResponse>;
  refreshAccessToken(refreshToken: string, proxyUrl: string | null): Promise<{ access_token: string; refresh_token?: string | null }>;
  tryAcquireRefreshLock(entryId: string): boolean;
  releaseRefreshLock(entryId: string): void;
  getProxyUrl(entryId: string): string | null;
  getLowQuotaUsedThreshold(kind: "primary" | "secondary"): number;
}

export class AccountQuotaProbeService {
  constructor(
    private readonly pool: ProbePool,
    private readonly deps: ProbeDependencies,
  ) {}

  async probe(entryId: string): Promise<AccountQuotaProbeResult> {
    const original = this.pool.getEntry(entryId);
    if (!original) throw new Error("Account not found");
    const routingStatus = original.status;

    try {
      return await this.fetchAndClassify(entryId, routingStatus, false);
    } catch (error) {
      if (!isTokenInvalidError(error)) return this.failure(entryId, routingStatus, false, error);
      if (routingStatus !== "disabled") return this.failure(entryId, routingStatus, false, error);
      return this.retryAfterRefresh(entryId, routingStatus, error);
    }
  }

  private async retryAfterRefresh(
    entryId: string,
    routingStatus: AccountStatus,
    originalError: unknown,
  ): Promise<AccountQuotaProbeResult> {
    const beforeLock = this.pool.getEntry(entryId);
    if (!beforeLock?.refreshToken) {
      return this.failure(entryId, routingStatus, false, originalError);
    }
    if (!this.deps.tryAcquireRefreshLock(entryId)) {
      return {
        routing_status: routingStatus,
        probe_status: "unknown_failure",
        quota_source: "live",
        token_refreshed: false,
        detail: "Refresh already in progress; probe could not safely verify credentials",
      };
    }

    let refreshTokenUsed: string | null = null;
    try {
      const latest = this.pool.getEntry(entryId);
      if (!latest) return this.failure(entryId, routingStatus, false, originalError);
      const diskRefreshToken = this.pool.readEntryRTFromDisk?.(entryId);
      const refreshToken = diskRefreshToken || latest.refreshToken;
      if (!refreshToken) return this.failure(entryId, routingStatus, false, originalError);
      refreshTokenUsed = refreshToken;

      const proxyUrl = this.deps.getProxyUrl(entryId);
      const tokens = await this.deps.refreshAccessToken(refreshToken, proxyUrl);
      this.pool.updateToken(entryId, tokens.access_token, tokens.refresh_token ?? undefined);
      try {
        return await this.fetchAndClassify(entryId, routingStatus, true);
      } catch (retryError) {
        return this.failure(entryId, routingStatus, true, retryError);
      }
    } catch (refreshError) {
      const classified = classifyProbeError(refreshError);
      return {
        routing_status: routingStatus,
        probe_status: classified === "unknown_failure" && isRefreshCredentialError(refreshError)
          ? "token_invalid"
          : classified,
        quota_source: "live",
        token_refreshed: false,
        detail: this.safeDetail(refreshError, entryId, refreshTokenUsed ? [refreshTokenUsed] : []),
      };
    } finally {
      this.deps.releaseRefreshLock(entryId);
    }
  }

  private async fetchAndClassify(
    entryId: string,
    routingStatus: AccountStatus,
    tokenRefreshed: boolean,
  ): Promise<AccountQuotaProbeResult> {
    const entry = this.pool.getEntry(entryId);
    if (!entry) throw new Error("Account not found");
    const usage = await this.deps.getUsage(
      entry.token,
      entry.accountId,
      entryId,
      this.deps.getProxyUrl(entryId),
    );
    const quota = toQuota(usage);
    this.pool.updateCachedQuota(entryId, quota);
    return {
      routing_status: routingStatus,
      probe_status: classifyQuota(quota, this.deps.getLowQuotaUsedThreshold),
      quota_source: "live",
      token_refreshed: tokenRefreshed,
      quota,
    };
  }

  private failure(
    entryId: string,
    routingStatus: AccountStatus,
    tokenRefreshed: boolean,
    error: unknown,
  ): AccountQuotaProbeResult {
    return {
      routing_status: routingStatus,
      probe_status: classifyProbeError(error),
      quota_source: "live",
      token_refreshed: tokenRefreshed,
      detail: this.safeDetail(error, entryId),
    };
  }

  private safeDetail(error: unknown, entryId?: string, extraSecrets: string[] = []): string {
    let detail = error instanceof Error ? error.message : String(error);
    const entry = entryId ? this.pool.getEntry(entryId) : undefined;
    const secrets = [...(entry
      ? [entry.token, entry.refreshToken].filter((value): value is string => Boolean(value))
      : []), ...extraSecrets];
    for (const secret of secrets) detail = detail.split(secret).join("[redacted]");
    return detail.slice(0, 256);
  }
}

export function classifyQuota(
  quota: CodexQuota,
  getThreshold: (kind: "primary" | "secondary") => number,
): AccountProbeStatus {
  if (quota.rate_limit.limit_reached ||
      quota.secondary_rate_limit?.limit_reached ||
      quota.code_review_rate_limit?.limit_reached) {
    return "quota_exhausted";
  }
  const secondaryUsed = quota.secondary_rate_limit?.used_percent;
  const primaryUsed = quota.rate_limit.used_percent;
  const isLow = typeof secondaryUsed === "number"
    ? secondaryUsed >= getThreshold("secondary")
    : typeof primaryUsed === "number" && primaryUsed >= getThreshold("primary");
  if (isLow) {
    return "quota_low";
  }
  return "available";
}

function isRefreshCredentialError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /invalid_grant|invalid_token|refresh_token_expired|refresh_token_reused|access_denied/.test(text);
}

export function classifyProbeError(error: unknown): AccountProbeStatus {
  if (isQuotaExhaustedError(error)) return "quota_exhausted";
  if (isTokenInvalidError(error)) return "token_invalid";
  if (isCfChallengeError(error) || isCfPathBlockError(error) || isHtmlError(error)) return "upstream_blocked";
  if (isBanError(error)) return "account_banned";
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/\b(eof|etimedout|timeout|econnreset|econnrefused|enotfound|network|socket hang up|tls)\b/i.test(text)) {
    return "transient_network";
  }
  return "unknown_failure";
}

function isHtmlError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const body = (error as unknown as { body?: unknown }).body;
  return typeof body === "string" && /<!doctype|<html/i.test(body);
}

export function createDefaultAccountQuotaProbeService(
  pool: AccountPool,
  getUsage: ProbeDependencies["getUsage"],
  getProxyUrl: ProbeDependencies["getProxyUrl"],
): AccountQuotaProbeService {
  return new AccountQuotaProbeService(pool, {
    getUsage,
    refreshAccessToken,
    tryAcquireRefreshLock,
    releaseRefreshLock,
    getProxyUrl,
    getLowQuotaUsedThreshold: (kind) => {
      const thresholds = getConfig().quota.warning_thresholds[kind];
      return Math.min(...thresholds);
    },
  });
}
