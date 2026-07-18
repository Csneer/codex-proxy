import { useCallback, useEffect, useState } from "preact/hooks";

export type OverviewRange = "today" | "24h" | "7d";
export interface CallOverviewData {
  range: { preset: OverviewRange; timezone: string; from: string; to: string };
  generatedAt: string;
  success: { count: number; previousCount: number; lastCompletedAt: string | null };
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheRatio: number };
  storage: { totalBytes: number };
  outcomes?: { failure: number; interrupted: number; retry: number };
  series?: Array<{ bucketStart: string; success: number }>;
  models: Array<{ model: string; count: number; share: number }>;
  contexts: Array<{ id: string; sessionId: string | null; taskId: string | null; cwd: string | null; callCount: number; lastCompletedAt: string }>;
}

export function useCallOverview(range: OverviewRange = "today") {
  const [data, setData] = useState<CallOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/admin/call-observability/overview?range=${range}&timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
      .then((value) => { setData(value); setError(null); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range, refreshKey]);
  return { data, loading, error, refresh };
}
