import { useCallback, useEffect, useState } from "preact/hooks";
import { adminFetch } from "../http/admin-fetch.js";
export interface UiAppearance { panelOpacity: number; cardOpacity: number; brightness: number; blurPx: number; enabled: boolean; hasBackground: boolean; backgroundUrl: string; theme: "light" | "dark"; backgroundContentType: "image/png" | "image/jpeg" | "image/webp"; }
export function useUiAppearance() {
  const [data, setData] = useState<UiAppearance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => { const response = await fetch("/admin/ui-appearance"); if (!response.ok) throw new Error(`HTTP ${response.status}`); setData(await response.json()); }, []);
  useEffect(() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [refresh]);
  const update = useCallback(async (patch: Partial<UiAppearance>) => { setData((previous) => previous ? { ...previous, ...patch } : previous); const response = await adminFetch("/admin/ui-appearance", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const next = await response.json(); setData(next); window.dispatchEvent(new CustomEvent("codex:appearance-updated", { detail: next })); }, []);
  const upload = useCallback(async (file: File) => { const response = await adminFetch("/admin/ui-background", { method: "POST", headers: { "Content-Type": file.type }, body: file }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const next = await response.json(); setData(next); window.dispatchEvent(new CustomEvent("codex:appearance-updated", { detail: next })); }, []);
  return { data, error, refresh, update, upload };
}
