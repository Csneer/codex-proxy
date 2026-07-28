import { useState, useEffect, useCallback, useMemo } from "preact/hooks";

export interface CatalogModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  outputModalities?: string[];
}

export interface ModelFamily {
  id: string;
  displayName: string;
  efforts: { reasoningEffort: string; description: string }[];
  defaultEffort: string;
}

/**
 * Extract model family ID from a model ID.
 * gpt-5.3-codex-high → gpt-5.3-codex
 * gpt-5.3-codex-spark → gpt-5.3-codex-spark (spark is a distinct family)
 * gpt-5.4 → gpt-5.4
 */
function getFamilyId(id: string): string {
  // Bare model: gpt-5.4
  if (/^gpt-\d+(?:\.\d+)?$/.test(id)) return id;
  // Spark family: gpt-X.Y-codex-spark
  if (/^gpt-\d+(?:\.\d+)?-codex-spark$/.test(id)) return id;
  // Mini family: gpt-X.Y-codex-mini
  if (/^gpt-\d+(?:\.\d+)?-codex-mini$/.test(id)) return id;
  // Codex base or tier variant (high/mid/low/max): family = gpt-X.Y-codex
  const m = id.match(/^(gpt-\d+(?:\.\d+)?-codex)(?:-(?:high|mid|low|max))?$/);
  if (m) return m[1];
  // Legacy: gpt-5-codex, gpt-5-codex-mini
  const legacy = id.match(/^(gpt-\d+-codex)(?:-(?:high|mid|low|max|mini))?$/);
  if (legacy) return legacy[1];
  return id;
}

/** Check if a model ID is a tier variant (not the base family model). */
function isTierVariant(id: string): boolean {
  return /^gpt-\d+(?:\.\d+)?-codex-(?:high|mid|low|max)$/.test(id);
}

function isSelectableChatModel(model: CatalogModel): boolean {
  if (model.outputModalities && !model.outputModalities.includes("text")) return false;
  return model.supportedReasoningEfforts.length > 0;
}

function selectDefaultModel(catalog: CatalogModel[], ids: string[]): string {
  const selectable = catalog.filter(isSelectableChatModel);
  return selectable.find((m) => m.isDefault)?.id ?? selectable[0]?.id ?? ids[0] ?? "";
}

export function useStatus(accountCount: number) {
  const [baseUrl, setBaseUrl] = useState("Loading...");
  const [apiKey, setApiKey] = useState("Loading...");
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelCatalog, setModelCatalog] = useState<CatalogModel[]>([]);
  const [selectedEffort, setSelectedEffort] = useState("medium");
  const [selectedSpeed, setSelectedSpeed] = useState<string | null>(null);

  const fetchModels = useCallback(async (
    isInitial: boolean,
    serviceKey: string,
    signal?: AbortSignal,
  ) => {
    try {
      // Fetch full catalog for effort info
      const headers = serviceKey ? { Authorization: `Bearer ${serviceKey}` } : undefined;
      const catalogResp = await fetch("/v1/models/catalog", { headers, signal });
      if (!catalogResp.ok) throw new Error(`Model catalog request failed: HTTP ${catalogResp.status}`);
      const catalogPayload: unknown = await catalogResp.json();
      if (!Array.isArray(catalogPayload)) throw new Error("Invalid model catalog response");
      const catalogData = catalogPayload as CatalogModel[];

      // Also fetch flat model list for compatibility with OpenAI clients.
      const resp = await fetch("/v1/models", { headers, signal });
      if (!resp.ok) throw new Error(`Model list request failed: HTTP ${resp.status}`);
      const payload: unknown = await resp.json();
      const entries = payload && typeof payload === "object"
        ? (payload as { data?: unknown }).data
        : undefined;
      if (!Array.isArray(entries)) throw new Error("Invalid model list response");
      const ids = entries
        .map((entry) => entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined)
        .filter((id): id is string => typeof id === "string");
      if (signal?.aborted) return;

      setModelCatalog(catalogData);
      setModels(ids);
      if (isInitial) {
        setSelectedModel(selectDefaultModel(catalogData, ids));
      } else {
        // On refresh: only reset if current selection is no longer available
        setSelectedModel((prev) => {
          if (ids.includes(prev)) return prev;
          return selectDefaultModel(catalogData, ids) || prev;
        });
      }
    } catch (err) {
      if (signal?.aborted) return;
      if (isInitial) setModels([]);
    }
  }, []);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const controller = new AbortController();

    async function loadStatus() {
      try {
        const resp = await fetch("/auth/status", { signal: controller.signal });
        if (!resp.ok) throw new Error(`Status request failed: HTTP ${resp.status}`);
        const data = await resp.json();
        if (controller.signal.aborted || !data.authenticated) return;
        const serviceKey = data.proxy_api_key || "any-string";
        setBaseUrl(`${window.location.origin}/v1`);
        setApiKey(serviceKey);
        await fetchModels(true, serviceKey, controller.signal);
        if (controller.signal.aborted) return;

        // Refresh model list every 60s to pick up dynamic backend changes
        intervalId = setInterval(() => {
          void fetchModels(false, serviceKey, controller.signal);
        }, 60_000);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Status load error:", err);
      }
    }
    void loadStatus();

    return () => {
      controller.abort();
      if (intervalId) clearInterval(intervalId);
    };
  }, [fetchModels, accountCount]);

  // Build model families — group catalog by family, excluding tier variants
  const modelFamilies = useMemo((): ModelFamily[] => {
    if (modelCatalog.length === 0) return [];

    const familyMap = new Map<string, ModelFamily>();
    for (const m of modelCatalog) {
      const fid = getFamilyId(m.id);
      // Only use selectable base family models (not tier variants) to define the family
      if (!isSelectableChatModel(m) || isTierVariant(m.id)) continue;
      if (familyMap.has(fid)) continue;
      familyMap.set(fid, {
        id: fid,
        displayName: m.displayName,
        efforts: m.supportedReasoningEfforts,
        defaultEffort: m.defaultReasoningEffort,
      });
    }
    return [...familyMap.values()];
  }, [modelCatalog]);

  return {
    baseUrl,
    apiKey,
    models,
    selectedModel,
    setSelectedModel,
    selectedEffort,
    setSelectedEffort,
    selectedSpeed,
    setSelectedSpeed,
    modelFamilies,
    modelCatalog,
  };
}
