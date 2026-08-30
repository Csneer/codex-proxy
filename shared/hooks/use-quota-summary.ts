import { useCallback, useEffect, useState } from "preact/hooks";

export interface QuotaSummaryWindow {
  window_seconds: number | null;
  source_windows: Array<"primary_rate_limit" | "secondary_rate_limit">;
  reported_accounts: number;
  missing_accounts: number;
  exhausted_accounts: number;
  remaining_percent_total: number;
  remaining_percent_average: number | null;
  earliest_reset_at: number | null;
  latest_reset_at: number | null;
}

export interface QuotaSummaryData {
  generated_at: string;
  source: "cached";
  active_accounts: number;
  accounts_with_cached_quota: number;
  accounts_without_cached_quota: number;
  oldest_quota_fetched_at: string | null;
  newest_quota_fetched_at: string | null;
  windows: {
    five_hour: QuotaSummaryWindow;
    seven_day: QuotaSummaryWindow;
    thirty_day: QuotaSummaryWindow;
    other: QuotaSummaryWindow[];
  };
}

export function useQuotaSummary() {
  const [data, setData] = useState<QuotaSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/quota-summary", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json() as QuotaSummaryData);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return { data, loading, error, refresh: load };
}
