import { useCallback, useEffect, useState } from "preact/hooks";
import { adminFetch } from "../http/admin-fetch.js";
export interface UiAppearance { panelOpacity: number; cardOpacity: number; brightness: number; blurPx: number; enabled: boolean; hasBackground: boolean; backgroundUrl: string; }
export function useUiAppearance() {
  const [data, setData] = useState<UiAppearance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => { const response = await fetch("/admin/ui-appearance"); if (!response.ok) throw new Error(`HTTP ${response.status}`); setData(await response.json()); }, []);
  useEffect(() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [refresh]);
  const update = useCallback(async (patch: Partial<UiAppearance>) => { const response = await adminFetch("/admin/ui-appearance", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); setData(await response.json()); }, []);
  const upload = useCallback(async (file: File) => { const response = await adminFetch("/admin/ui-background", { method: "POST", headers: { "Content-Type": file.type }, body: file }); if (!response.ok) throw new Error(`HTTP ${response.status}`); setData(await response.json()); }, []);
  return { data, error, refresh, update, upload };
}
