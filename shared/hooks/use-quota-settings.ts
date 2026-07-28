import { useState, useEffect, useCallback } from "preact/hooks";
import { extractErrorMessage } from "../utils/extract-error";
import { adminFetch } from "../http/admin-fetch.js";

export interface QuotaSettingsData {
  refresh_interval_minutes: number;
  warning_thresholds: { primary: number[]; secondary: number[] };
  skip_exhausted: boolean;
  concurrency: number;
}

export function useQuotaSettings() {
  const [data, setData] = useState<QuotaSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/quota-settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result: QuotaSettingsData = await resp.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(async (patch: Partial<QuotaSettingsData>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const resp = await adminFetch("/admin/quota-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      const result = await resp.json() as { success: boolean } & QuotaSettingsData;
      setData({
        refresh_interval_minutes: result.refresh_interval_minutes,
        warning_thresholds: result.warning_thresholds,
        skip_exhausted: result.skip_exhausted,
        concurrency: result.concurrency,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { data, saving, saved, error, save, load };
}
