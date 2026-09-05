/**
 * Shared quota conversion utility.
 * Converts CodexUsageResponse (raw backend) → CodexQuota (normalized).
 */

import type { CodexQuota, CodexQuotaCredits, CodexQuotaWindow } from "./types.js";
import type { CodexUsageCredits, CodexUsageRateLimit, CodexUsageResponse } from "../proxy/codex-api.js";

function normalizeCredits(raw: CodexUsageCredits | null | undefined): CodexQuotaCredits | null {
  if (!raw) return null;
  // balance must be parseable — upstream always sends a decimal string,
  // but defensively reject malformed payloads so the dashboard never
  // shows NaN credits.
  if (typeof raw.balance !== "string") return null;
  const balance = Number(raw.balance);
  if (!Number.isFinite(balance)) return null;
  return {
    has_credits: Boolean(raw.has_credits),
    unlimited: Boolean(raw.unlimited),
    overage_limit_reached: Boolean(raw.overage_limit_reached),
    balance,
  };
}

function remainingPercent(used: number | null | undefined): number | null {
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - Math.max(0, Math.min(100, used)))));
}

function isReviewLimitId(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return normalized === "review" ||
    normalized === "code_review" ||
    normalized === "codex_review" ||
    normalized === "codex_code_review" ||
    normalized.includes("code_review") ||
    normalized.includes("codex_review");
}

function quotaFromRateLimit(rateLimit: CodexUsageRateLimit | null | undefined) {
  if (!rateLimit) return null;
  const usedPercent = rateLimit.primary_window?.used_percent ?? null;
  return {
    allowed: rateLimit.allowed,
    limit_reached: rateLimit.limit_reached,
    used_percent: usedPercent,
    remaining_percent: remainingPercent(usedPercent),
    reset_at: rateLimit.primary_window?.reset_at ?? null,
    limit_window_seconds: rateLimit.primary_window?.limit_window_seconds ?? null,
  };
}

function secondaryQuotaFromRateLimit(rateLimit: CodexUsageRateLimit | null | undefined) {
  const secondary = rateLimit?.secondary_window;
  if (!secondary) return null;
  const usedPercent = secondary.used_percent ?? null;
  return {
    limit_reached: secondary.used_percent != null ? secondary.used_percent >= 100 : Boolean(rateLimit?.limit_reached),
    used_percent: usedPercent,
    remaining_percent: remainingPercent(usedPercent),
    reset_at: secondary.reset_at ?? null,
    limit_window_seconds: secondary.limit_window_seconds ?? null,
  };
}

export function toQuota(usage: CodexUsageResponse): CodexQuota {
  const sw = usage.rate_limit.secondary_window;
  const primaryUsedPercent = usage.rate_limit.primary_window?.used_percent ?? null;
  const additional = usage.additional_rate_limits ?? [];
  const rateLimitsByLimitId: NonNullable<CodexQuota["rate_limits_by_limit_id"]> = {};
  for (const item of additional) {
    const limitId = item.metered_feature?.trim();
    if (!limitId) continue;
    const q = quotaFromRateLimit(item.rate_limit);
    if (!q) continue;
    rateLimitsByLimitId[limitId] = {
      limit_id: limitId,
      limit_name: item.limit_name || null,
      ...q,
      secondary_rate_limit: secondaryQuotaFromRateLimit(item.rate_limit),
    };
  }
  const additionalReview = additional.find((item) =>
    isReviewLimitId(item.metered_feature) || isReviewLimitId(item.limit_name)
  );
  const codeReviewRateLimit =
    quotaFromRateLimit(usage.code_review_rate_limit) ??
    quotaFromRateLimit(additionalReview?.rate_limit);

  return {
    plan_type: usage.plan_type,
    rate_limit: {
      allowed: usage.rate_limit.allowed,
      limit_reached: usage.rate_limit.limit_reached,
      used_percent: primaryUsedPercent,
      remaining_percent: remainingPercent(primaryUsedPercent),
      reset_at: usage.rate_limit.primary_window?.reset_at ?? null,
      limit_window_seconds: usage.rate_limit.primary_window?.limit_window_seconds ?? null,
    },
    secondary_rate_limit: secondaryQuotaFromRateLimit(usage.rate_limit),
    code_review_rate_limit: codeReviewRateLimit,
    rate_limits_by_limit_id: Object.keys(rateLimitsByLimitId).length > 0
      ? rateLimitsByLimitId
      : null,
    reset_credits_available:
      typeof usage.rate_limit_reset_credits?.available_count === "number" &&
      Number.isFinite(usage.rate_limit_reset_credits.available_count)
        ? usage.rate_limit_reset_credits.available_count
        : null,
    credits: normalizeCredits(usage.credits),
  };
}

export function getRateLimitIdForModel(model?: string | null): string | null {
  if (!model) return null;
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("spark") || normalized.includes("bengalfox")) {
    return "codex_bengalfox";
  }
  return null;
}

/** Only windows whose percentage was actually observed can receive a fresh timestamp. */
export function observedQuotaMeters(quota: CodexQuota | null): Array<[string, CodexQuotaWindow]> {
  if (!quota) return [];
  const windows: Array<[string, CodexQuotaWindow | null | undefined]> = [
    ["primary", quota.rate_limit],
    ["secondary", quota.secondary_rate_limit],
    ["code_review", quota.code_review_rate_limit],
  ];
  for (const [id, window] of Object.entries(quota.rate_limits_by_limit_id ?? {})) {
    windows.push([id + ":primary", window], [id + ":secondary", window.secondary_rate_limit]);
  }
  return windows.filter((item): item is [string, CodexQuotaWindow] =>
    typeof item[1]?.used_percent === "number" && Number.isFinite(item[1].used_percent));
}

/** Response headers/events are partial observations, never a full /usage replacement. */
export function mergePartialQuota(existing: CodexQuota | null, incoming: CodexQuota): CodexQuota {
  if (!existing) return incoming;
  const nowSec = Date.now() / 1000;
  type LockedWindow = CodexQuotaWindow & { limit_reached: boolean };
  const mergeWindow = <T extends LockedWindow>(
    previous: T | null, next: T | null,
  ): T | null => {
    if (!next || next.used_percent == null) return previous ?? next;
    if (!previous) return next;
    // A late successful sibling response is not proof that a learned 429 lock
    // was lifted. An authoritative snapshot or the reset time can clear it.
    if (previous.limit_reached && previous.reset_at != null && previous.reset_at > nowSec &&
        (!next.limit_reached || (next.reset_at ?? 0) < previous.reset_at)) return previous;
    return {
      ...next,
      reset_at: next.reset_at ?? previous.reset_at,
      limit_window_seconds: next.limit_window_seconds ?? previous.limit_window_seconds,
    };
  };
  const existingBuckets = existing.rate_limits_by_limit_id ?? {};
  const incomingBuckets = incoming.rate_limits_by_limit_id;
  const mergedBuckets = incomingBuckets
    ? Object.fromEntries(Object.entries(incomingBuckets).map(([limitId, next]) => {
      const previous = existingBuckets[limitId];
      if (!previous) return [limitId, next];
      const mergedPrimary = mergeWindow(previous, next)!;
      return [limitId, {
        ...previous,
        ...next,
        ...mergedPrimary,
        secondary_rate_limit: mergeWindow(
          previous.secondary_rate_limit ?? null,
          next.secondary_rate_limit ?? null,
        ),
      }];
    }))
    : existing.rate_limits_by_limit_id;
  return {
    ...existing,
    ...incoming,
    rate_limit: mergeWindow(existing.rate_limit, incoming.rate_limit)!,
    secondary_rate_limit: mergeWindow(existing.secondary_rate_limit, incoming.secondary_rate_limit),
    code_review_rate_limit: mergeWindow(existing.code_review_rate_limit, incoming.code_review_rate_limit),
    rate_limits_by_limit_id: incomingBuckets
      ? { ...existingBuckets, ...mergedBuckets }
      : existing.rate_limits_by_limit_id,
  };
}
