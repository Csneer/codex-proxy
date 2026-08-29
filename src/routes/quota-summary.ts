import type { Context } from "hono";
import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { CodexQuotaWindow } from "../auth/types.js";
import { getConfig } from "../config.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { isPrivateNetworkAddress } from "../utils/is-private-network.js";

interface WindowInput extends CodexQuotaWindow {
  limit_reached?: boolean;
}

type SourceWindow = "primary_rate_limit" | "secondary_rate_limit";

interface WindowSample {
  accountId: string;
  sourceWindow: SourceWindow;
  window: WindowInput;
}

interface QuotaWindowSummary {
  window_seconds: number | null;
  source_windows: SourceWindow[];
  reported_accounts: number;
  missing_accounts: number;
  exhausted_accounts: number;
  remaining_percent_total: number;
  remaining_percent_average: number | null;
  earliest_reset_at: number | null;
  latest_reset_at: number | null;
}

export interface QuotaSummary {
  generated_at: string;
  source: "cached";
  active_accounts: number;
  accounts_with_cached_quota: number;
  accounts_without_cached_quota: number;
  oldest_quota_fetched_at: string | null;
  newest_quota_fetched_at: string | null;
  windows: {
    five_hour: QuotaWindowSummary;
    seven_day: QuotaWindowSummary;
    thirty_day: QuotaWindowSummary;
    other: QuotaWindowSummary[];
  };
}

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const KNOWN_WINDOW_SECONDS = new Set([
  FIVE_HOURS_SECONDS,
  SEVEN_DAYS_SECONDS,
  THIRTY_DAYS_SECONDS,
]);

function finitePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function remainingPercent(window: WindowInput | null | undefined): number | null {
  if (!window) return null;
  const explicit = finitePercent(window.remaining_percent);
  if (explicit !== null) return explicit;
  const used = finitePercent(window.used_percent);
  return used === null ? null : 100 - used;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizedWindowSeconds(window: WindowInput): number | null {
  return typeof window.limit_window_seconds === "number" && Number.isFinite(window.limit_window_seconds)
    ? window.limit_window_seconds
    : null;
}

function summarizeWindowDuration(
  samples: WindowSample[],
  windowSeconds: number | null,
  activeAccountCount: number,
): QuotaWindowSummary {
  const matching = samples.filter((sample) => normalizedWindowSeconds(sample.window) === windowSeconds);
  const byAccount = new Map<string, WindowSample>();
  for (const sample of matching) {
    const existing = byAccount.get(sample.accountId);
    const sampleRemaining = remainingPercent(sample.window);
    const existingRemaining = existing ? remainingPercent(existing.window) : null;
    // If an unusual upstream payload exposes two top-level windows with the
    // same duration, count the account once and retain the binding (lower)
    // remaining quota rather than inflating aggregate capacity.
    if (!existing || (sampleRemaining !== null && (existingRemaining === null || sampleRemaining < existingRemaining))) {
      byAccount.set(sample.accountId, sample);
    }
  }

  let total = 0;
  let exhausted = 0;
  const resetTimes: number[] = [];
  const sourceWindows = new Set<SourceWindow>();

  for (const sample of byAccount.values()) {
    const remaining = remainingPercent(sample.window)!;
    total += remaining;
    if (sample.window.limit_reached === true || remaining === 0) exhausted += 1;
    if (typeof sample.window.reset_at === "number" && Number.isFinite(sample.window.reset_at)) {
      resetTimes.push(sample.window.reset_at);
    }
    sourceWindows.add(sample.sourceWindow);
  }
  const reported = byAccount.size;

  return {
    window_seconds: windowSeconds,
    source_windows: [...sourceWindows].sort(),
    reported_accounts: reported,
    missing_accounts: activeAccountCount - reported,
    exhausted_accounts: exhausted,
    remaining_percent_total: round(total),
    remaining_percent_average: reported === 0 ? null : round(total / reported),
    earliest_reset_at: resetTimes.length === 0 ? null : Math.min(...resetTimes),
    latest_reset_at: resetTimes.length === 0 ? null : Math.max(...resetTimes),
  };
}

export function buildQuotaSummary(pool: AccountPool, now = new Date()): QuotaSummary {
  const activeAccounts = pool.getAccounts().filter((account) => account.status === "active");
  const fetchedAt = activeAccounts
    .map((account) => account.quotaFetchedAt)
    .filter((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)))
    .sort();
  const withCachedQuota = activeAccounts.filter((account) => account.quota != null).length;
  const samples: WindowSample[] = [];
  for (const account of activeAccounts) {
    const primary = account.quota?.rate_limit;
    if (primary && remainingPercent(primary) !== null) {
      samples.push({ accountId: account.id, sourceWindow: "primary_rate_limit", window: primary });
    }
    const secondary = account.quota?.secondary_rate_limit;
    if (secondary && remainingPercent(secondary) !== null) {
      samples.push({ accountId: account.id, sourceWindow: "secondary_rate_limit", window: secondary });
    }
  }
  const otherDurations = [...new Set(
    samples
      .map((sample) => normalizedWindowSeconds(sample.window))
      .filter((seconds) => seconds === null || !KNOWN_WINDOW_SECONDS.has(seconds)),
  )].sort((a, b) => a === null ? 1 : b === null ? -1 : a - b);

  return {
    generated_at: now.toISOString(),
    source: "cached",
    active_accounts: activeAccounts.length,
    accounts_with_cached_quota: withCachedQuota,
    accounts_without_cached_quota: activeAccounts.length - withCachedQuota,
    oldest_quota_fetched_at: fetchedAt[0] ?? null,
    newest_quota_fetched_at: fetchedAt.at(-1) ?? null,
    windows: {
      five_hour: summarizeWindowDuration(samples, FIVE_HOURS_SECONDS, activeAccounts.length),
      seven_day: summarizeWindowDuration(samples, SEVEN_DAYS_SECONDS, activeAccounts.length),
      thirty_day: summarizeWindowDuration(samples, THIRTY_DAYS_SECONDS, activeAccounts.length),
      other: otherDurations.map((seconds) => summarizeWindowDuration(samples, seconds, activeAccounts.length)),
    },
  };
}

export function createQuotaSummaryRoutes(
  pool: AccountPool,
  options: {
    resolveClientIp?: (c: Context) => string;
    now?: () => Date;
  } = {},
): Hono {
  const app = new Hono();

  app.get("/api/quota-summary", (c) => {
    const clientIp = options.resolveClientIp?.(c) ?? getRealClientIp(c, getConfig().server.trust_proxy);
    if (!isPrivateNetworkAddress(clientIp)) {
      c.status(403);
      return c.json({ error: "LAN access required" });
    }

    c.header("Cache-Control", "no-store");
    return c.json(buildQuotaSummary(pool, options.now?.() ?? new Date()));
  });

  return app;
}
