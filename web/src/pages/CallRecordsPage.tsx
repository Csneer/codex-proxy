import { useT } from "../../../shared/i18n/context";
import {
  useCallRecords,
  type CallRecordDetail,
  type CallRecordFilters,
} from "../../../shared/hooks/use-call-records";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function toDateTimeLocal(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromDateTimeLocal(value: string): string {
  return value ? new Date(value).toISOString() : "";
}

function DetailPanel({ selected }: { selected: CallRecordDetail | null }) {
  const t = useT();
  if (!selected) {
    return <div class="p-3 text-xs text-slate-500">{t("callRecordsSelectHint")}</div>;
  }
  const truncated = selected.requestTruncated || selected.responseTruncated;
  let requestValue: any = null;
  let responseValue: any = null;
  try { requestValue = JSON.parse(selected.requestJson); } catch { requestValue = selected.requestJson; }
  try { responseValue = JSON.parse(selected.responseJson); } catch { responseValue = selected.responseJson; }
  const semanticText = (value: any): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(semanticText).filter(Boolean).join("\n");
    if (value && typeof value === "object") return String(value.output_text ?? value.text ?? value.content ?? value.message ?? "");
    return "";
  };
  return (
    <div class="p-3 space-y-3 text-reading max-h-[620px] overflow-auto">
      {truncated && (
        <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          {t("callRecordsTruncated")}
        </div>
      )}
      <div>
        <div class="text-section font-semibold mb-1">用户输入</div>
        <div class="whitespace-pre-wrap break-words rounded-xl bg-primary-container/40 p-3">{semanticText(requestValue) || "未提取到文本内容"}</div>
      </div>
      <div>
        <div class="text-section font-semibold mb-1">模型输出</div>
        <div class="whitespace-pre-wrap break-words rounded-xl bg-white/50 dark:bg-black/20 p-3">{semanticText(responseValue) || "未提取到最终文本"}</div>
      </div>
      <details class="rounded-xl border border-slate-200/70 dark:border-border-dark p-3">
        <summary class="cursor-pointer text-control font-semibold">查看原始证据</summary>
        <div class="mt-3 space-y-3">
          <pre class="whitespace-pre-wrap break-all rounded-md bg-slate-50 dark:bg-[#11161d] p-2 text-control">{prettyJson(selected.requestJson)}</pre>
          <pre class="whitespace-pre-wrap break-all rounded-md bg-slate-50 dark:bg-[#11161d] p-2 text-control">{prettyJson(selected.responseJson)}</pre>
        </div>
      </details>
    </div>
  );
}

export function CallRecordsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const calls = useCallRecords();
  const inputClass = "px-2.5 py-1.5 rounded-md text-xs bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark";
  const pageStart = calls.total === 0 ? 0 : calls.page * calls.pageSize + 1;
  const pageEnd = Math.min(calls.total, (calls.page + 1) * calls.pageSize);

  const setTextFilter = (key: keyof CallRecordFilters) => (event: Event) => {
    calls.setFilter(key, (event.target as HTMLInputElement).value as never);
  };

  const confirmClear = () => {
    if (window.confirm(t("callRecordsClearConfirm"))) void calls.clearRecords();
  };

  return (
    <div class={`flex flex-col gap-4 ${embedded ? "" : "p-6"}`}>
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 class="text-lg font-bold">{t("callRecordsTitle")}</h2>
          <p class="text-xs text-slate-500 dark:text-text-dim">{t("callRecordsSubtitle")}</p>
        </div>
        <div class="flex items-center gap-2">
          <button class="px-3 py-1.5 rounded-lg text-xs bg-slate-200 text-slate-700" onClick={calls.refresh}>
            {t("refreshList")}
          </button>
          <button
            class="px-3 py-1.5 rounded-lg text-xs bg-red-50 text-red-600 disabled:opacity-50"
            disabled={calls.clearing || (calls.state?.rowCount ?? 0) === 0}
            onClick={confirmClear}
          >
            {t("callRecordsClear")}
          </button>
        </div>
      </div>

      {calls.state && (
        <div class="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-slate-200 dark:border-border-dark bg-white dark:bg-card-dark px-3 py-2 text-xs text-slate-500">
          <span>{calls.state.enabled ? t("callRecordsEnabled") : t("callRecordsDisabled")}</span>
          <span>{t("callRecordsStored", { count: calls.state.rowCount })}</span>
          <span>{formatBytes(calls.state.databaseBytes)}</span>
          <span>{calls.state.searchMode.toUpperCase()}</span>
          <span class="truncate max-w-[360px]" title={calls.state.path}>{calls.state.path}</span>
        </div>
      )}

      <div class="flex flex-wrap items-center gap-2">
        {(["calls", "contexts"] as const).map((view) => (
          <button
            key={view}
            class={`px-3 py-1.5 rounded-lg text-xs font-medium ${calls.view === view ? "bg-primary-action text-white" : "bg-slate-200 text-slate-600"}`}
            onClick={() => calls.setView(view)}
          >
            {view === "calls" ? t("callRecordsCalls") : t("callRecordsContexts")}
          </button>
        ))}
        <input
          class={`${inputClass} min-w-[240px] flex-1`}
          value={calls.filters.search}
          onInput={setTextFilter("search")}
          placeholder={t("callRecordsSearch")}
        />
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        <input
          class={inputClass}
          type="datetime-local"
          aria-label={t("callRecordsFrom")}
          value={toDateTimeLocal(calls.filters.from)}
          onInput={(event) => calls.setFilter("from", fromDateTimeLocal((event.target as HTMLInputElement).value))}
        />
        <input
          class={inputClass}
          type="datetime-local"
          aria-label={t("callRecordsTo")}
          value={toDateTimeLocal(calls.filters.to)}
          onInput={(event) => calls.setFilter("to", fromDateTimeLocal((event.target as HTMLInputElement).value))}
        />
        <input class={inputClass} value={calls.filters.sessionId} onInput={setTextFilter("sessionId")} placeholder={t("callRecordsSession")} />
        <input class={inputClass} value={calls.filters.taskId} onInput={setTextFilter("taskId")} placeholder={t("callRecordsTask")} />
        <input class={inputClass} value={calls.filters.cwd} onInput={setTextFilter("cwd")} placeholder={t("callRecordsCwd")} />
        <input class={inputClass} value={calls.filters.model} onInput={setTextFilter("model")} placeholder={t("callRecordsModel")} />
        <input class={inputClass} value={calls.filters.provider} onInput={setTextFilter("provider")} placeholder={t("callRecordsProvider")} />
        <input class={inputClass} value={calls.filters.accountId} onInput={setTextFilter("accountId")} placeholder={t("callRecordsAccount")} />
        <select class={inputClass} value={calls.filters.protocol} onChange={setTextFilter("protocol")}>
          <option value="">{t("callRecordsAllProtocols")}</option>
          <option value="responses">Responses</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Gemini</option>
          <option value="official-agent">Official Agent</option>
        </select>
        <select class={inputClass} value={calls.filters.stream} onChange={setTextFilter("stream")}>
          <option value="">{t("callRecordsAllModes")}</option>
          <option value="true">{t("callRecordsStreaming")}</option>
          <option value="false">{t("callRecordsNonStreaming")}</option>
        </select>
        <select class={inputClass} value={calls.filters.sort} onChange={setTextFilter("sort")}>
          <option value="completed_at">{t("callRecordsSortTime")}</option>
          <option value="latency_ms">{t("callRecordsLatency")}</option>
          <option value="input_tokens">{t("callRecordsInputTokens")}</option>
          <option value="output_tokens">{t("callRecordsOutputTokens")}</option>
        </select>
        <select class={inputClass} value={calls.filters.order} onChange={setTextFilter("order")}>
          <option value="desc">{t("callRecordsDescending")}</option>
          <option value="asc">{t("callRecordsAscending")}</option>
        </select>
        <button class={`${inputClass} text-slate-600`} onClick={calls.resetFilters}>{t("callRecordsResetFilters")}</button>
      </div>

      {calls.error && <div class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{calls.error}</div>}

      <div class="flex flex-col lg:flex-row gap-4 min-w-0">
        <div class="flex-1 min-w-0 border border-slate-200 dark:border-border-dark rounded-lg overflow-hidden bg-white dark:bg-bg-dark">
          {calls.loading && <div class="p-4 text-xs text-slate-500">{t("callRecordsLoading")}</div>}
          {!calls.loading && calls.total === 0 && <div class="p-4 text-xs text-slate-500">{t("callRecordsEmpty")}</div>}
          {calls.view === "calls" && calls.records.map((record) => (
            <button
              key={record.id}
              class="w-full text-left grid grid-cols-12 gap-2 px-3 py-2 text-xs border-b border-slate-100 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark"
              onClick={() => calls.selectRecord(record.id)}
            >
              <div class="col-span-3">
                <div class="font-semibold">{record.model}</div>
                <div class="text-slate-500">{new Date(record.completedAt).toLocaleString()}</div>
              </div>
              <div class="col-span-2">{record.provider}<div class="text-slate-500">{record.protocol}</div></div>
              <div class="col-span-3 truncate" title={record.cwd ?? record.sessionId ?? ""}>{record.cwd ?? record.sessionId ?? "-"}</div>
              <div class="col-span-2">{record.inputTokens.toLocaleString()} / {record.outputTokens.toLocaleString()}</div>
              <div class="col-span-2">{record.latencyMs}ms</div>
            </button>
          ))}
          {calls.view === "contexts" && calls.contexts.map((context) => (
            <button
              key={context.id}
              class="w-full text-left grid grid-cols-12 gap-2 px-3 py-2 text-xs border-b border-slate-100 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark"
              onClick={() => calls.drillIntoContext(context.id)}
            >
              <div class="col-span-4"><div class="font-semibold truncate">{context.cwd ?? context.sessionId ?? context.taskId ?? "-"}</div><div class="text-slate-500">{context.source}</div></div>
              <div class="col-span-3 truncate">{context.sessionId ?? "-"}</div>
              <div class="col-span-2">{t("callRecordsCallCount", { count: context.callCount })}</div>
              <div class="col-span-3">{context.inputTokens.toLocaleString()} / {context.outputTokens.toLocaleString()}</div>
            </button>
          ))}
          <div class="flex items-center justify-between px-3 py-2 text-xs text-slate-500">
            <button disabled={!calls.hasPrev} class="disabled:opacity-40" onClick={calls.prevPage}>{t("prevPage")}</button>
            <span>{calls.total} {t("totalItems")} · {pageStart}-{pageEnd}</span>
            <button disabled={!calls.hasNext} class="disabled:opacity-40" onClick={calls.nextPage}>{t("nextPage")}</button>
          </div>
        </div>

        <div class="w-full lg:w-[420px] shrink-0 border border-slate-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark">
          <div class="px-3 py-2 text-xs text-slate-500 border-b border-slate-200 dark:border-border-dark">{t("callRecordsDetails")}</div>
          <DetailPanel selected={calls.selected} />
        </div>
      </div>
    </div>
  );
}
