import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { extractErrorMessage } from "../utils/extract-error";
import { adminFetch } from "../http/admin-fetch.js";

export type CallRecordsView = "calls" | "contexts";
export type CallRecordProtocol = "" | "openai" | "anthropic" | "gemini" | "responses" | "official-agent";

export interface CallRecordFilters {
  from: string;
  to: string;
  contextId: string;
  search: string;
  sessionId: string;
  taskId: string;
  cwd: string;
  model: string;
  provider: string;
  accountId: string;
  protocol: CallRecordProtocol;
  stream: "" | "true" | "false";
  sort: "completed_at" | "latency_ms" | "input_tokens" | "output_tokens";
  order: "asc" | "desc";
}

export interface CallRecordSummary {
  id: string;
  requestId: string;
  completedAt: string;
  latencyMs: number;
  route: string;
  protocol: Exclude<CallRecordProtocol, "">;
  provider: string;
  accountId: string | null;
  model: string;
  upstreamModel: string | null;
  stream: boolean;
  responseId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  requestTruncated: boolean;
  responseTruncated: boolean;
  sessionId: string | null;
  taskId: string | null;
  cwd: string | null;
  requestPreview: string;
  responsePreview: string;
}

export interface CallRecordDetail extends CallRecordSummary {
  requestJson: string;
  responseJson: string;
  contextSource: string | null;
}

export interface CallContextSummary {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  cwd: string | null;
  source: string;
  lastCompletedAt: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface CallRecordState {
  enabled: boolean;
  retentionDays: number | null;
  maxBodyBytes: number;
  path: string;
  rowCount: number;
  contextCount: number;
  databaseBytes: number;
  searchMode: "fts5" | "like";
}

export const DEFAULT_CALL_RECORD_FILTERS: CallRecordFilters = {
  from: "",
  to: "",
  contextId: "",
  search: "",
  sessionId: "",
  taskId: "",
  cwd: "",
  model: "",
  provider: "",
  accountId: "",
  protocol: "",
  stream: "",
  sort: "completed_at",
  order: "desc",
};

interface CallRecordsQueryState {
  view: CallRecordsView;
  filters: CallRecordFilters;
  page: number;
  selectedId: string | null;
}

export function normalizeCallRecordsQueryState(
  previous: CallRecordsQueryState,
  patch: Partial<CallRecordsQueryState>,
): CallRecordsQueryState {
  const view = patch.view ?? previous.view;
  const filters = patch.filters ?? previous.filters;
  const page = patch.page ?? previous.page;
  const queryChanged = view !== previous.view || filters !== previous.filters;
  const pageChanged = page !== previous.page;
  return {
    view,
    filters,
    page: queryChanged ? 0 : page,
    selectedId: queryChanged || pageChanged ? null : (patch.selectedId ?? previous.selectedId),
  };
}

export function buildCallRecordsQuery(filters: CallRecordFilters, page: number, pageSize: number): URLSearchParams {
  const params = new URLSearchParams();
  const textFilters: Array<[string, string]> = [
    ["from", filters.from],
    ["to", filters.to],
    ["context_id", filters.contextId],
    ["search", filters.search.trim()],
    ["session_id", filters.sessionId.trim()],
    ["task_id", filters.taskId.trim()],
    ["cwd", filters.cwd.trim()],
    ["model", filters.model.trim()],
    ["provider", filters.provider.trim()],
    ["account_id", filters.accountId.trim()],
    ["protocol", filters.protocol],
    ["stream", filters.stream],
  ];
  for (const [key, value] of textFilters) {
    if (value) params.set(key, value);
  }
  params.set("sort", filters.sort);
  params.set("order", filters.order);
  params.set("limit", String(pageSize));
  params.set("offset", String(page * pageSize));
  return params;
}

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return extractErrorMessage(body, `HTTP ${response.status}`);
}

export function useCallRecords(pageSize = 50) {
  const [view, setViewState] = useState<CallRecordsView>("calls");
  const [filters, setFilters] = useState<CallRecordFilters>(DEFAULT_CALL_RECORD_FILTERS);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [records, setRecords] = useState<CallRecordSummary[]>([]);
  const [contexts, setContexts] = useState<CallContextSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<CallRecordDetail | null>(null);
  const [state, setState] = useState<CallRecordState | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), 250);
    return () => clearTimeout(timer);
  }, [filters.search]);

  const queryFilters = useMemo(() => ({
    from: filters.from,
    to: filters.to,
    contextId: filters.contextId,
    search: debouncedSearch,
    sessionId: filters.sessionId,
    taskId: filters.taskId,
    cwd: filters.cwd,
    model: filters.model,
    provider: filters.provider,
    accountId: filters.accountId,
    protocol: filters.protocol,
    stream: filters.stream,
    sort: filters.sort,
    order: filters.order,
  }), [
    debouncedSearch,
    filters.accountId,
    filters.contextId,
    filters.cwd,
    filters.from,
    filters.model,
    filters.order,
    filters.protocol,
    filters.provider,
    filters.sessionId,
    filters.sort,
    filters.stream,
    filters.taskId,
    filters.to,
  ]);

  const loadState = useCallback(async () => {
    const response = await fetch("/admin/call-records/state");
    if (!response.ok) throw new Error(await responseError(response));
    setState(await response.json());
  }, []);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = buildCallRecordsQuery(queryFilters, page, pageSize);
      let url = "/admin/call-records";
      if (view === "contexts") {
        url = "/admin/call-contexts";
        params.set("sort", "updated_at");
      }
      const response = await fetch(`${url}?${params.toString()}`);
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      if (view === "calls") {
        setRecords(body.records ?? []);
        setContexts([]);
      } else {
        setContexts(body.contexts ?? []);
        setRecords([]);
      }
      setTotal(body.total ?? 0);
      await loadState();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [loadState, page, pageSize, queryFilters, view]);

  useEffect(() => {
    if (filters.search !== debouncedSearch) return;
    void loadPage();
  }, [debouncedSearch, filters.search, loadPage, refreshKey]);

  const setView = useCallback((nextView: CallRecordsView) => {
    setViewState(nextView);
    setPage(0);
    setSelected(null);
  }, []);

  const setFilter = useCallback(<K extends keyof CallRecordFilters>(key: K, value: CallRecordFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setPage(0);
    setSelected(null);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_CALL_RECORD_FILTERS);
    setPage(0);
    setSelected(null);
  }, []);

  const drillIntoContext = useCallback((contextId: string) => {
    setViewState("calls");
    setFilters((previous) => ({ ...previous, contextId }));
    setPage(0);
    setSelected(null);
  }, []);

  const selectRecord = useCallback(async (id: string) => {
    setError(null);
    try {
      const response = await fetch(`/admin/call-records/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(await responseError(response));
      setSelected(await response.json());
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
    }
  }, []);

  const clearRecords = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      const response = await adminFetch("/admin/call-records/clear", { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      setSelected(null);
      setPage(0);
      setRefreshKey((value) => value + 1);
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    } finally {
      setClearing(false);
    }
  }, []);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  const prevPage = useCallback(() => {
    setPage((value) => Math.max(0, value - 1));
    setSelected(null);
  }, []);
  const nextPage = useCallback(() => {
    setPage((value) => value + 1);
    setSelected(null);
  }, []);

  return {
    view, setView, filters, setFilter, resetFilters, drillIntoContext, records, contexts, total, page, pageSize,
    hasPrev: page > 0,
    hasNext: (page + 1) * pageSize < total,
    prevPage, nextPage, loading, error, selected, selectRecord, state,
    refresh, clearRecords, clearing,
  };
}
