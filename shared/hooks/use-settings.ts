import { useState, useEffect, useCallback } from "preact/hooks";
import { extractErrorMessage } from "../utils/extract-error";
import { adminFetch } from "../http/admin-fetch.js";
import { notifyDashboardAuthExpired } from "./use-dashboard-auth.js";

export function useSettings() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [adminKeyConfigured, setAdminKeyConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: { proxy_api_key: string | null; admin_key_configured: boolean } = await resp.json();
      setApiKey(data.proxy_api_key);
      setAdminKeyConfigured(data.admin_key_configured);
      setLoaded(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const saveServiceKey = useCallback(async (newKey: string | null) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const resp = await adminFetch("/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy_api_key: newKey }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      const result: { proxy_api_key: string | null } = await resp.json();
      setApiKey(result.proxy_api_key);
      setSaved(true);
      // Auto-clear saved indicator after 3s
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const rotateAdminKey = useCallback(async (adminKey: string) => {
    const nextKey = adminKey.trim();
    if (!nextKey) throw new Error("Dashboard/Admin key is required");
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const resp = await adminFetch("/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admin_key: nextKey }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      const result = await resp.json() as { admin_key_configured: boolean; reauth_required: boolean };
      setAdminKeyConfigured(result.admin_key_configured);
      if (result.reauth_required) notifyDashboardAuthExpired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { apiKey, adminKeyConfigured, loaded, saving, saved, error, saveServiceKey, rotateAdminKey, load };
}
