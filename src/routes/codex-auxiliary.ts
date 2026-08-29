/** Non-streaming Codex API-key auxiliary endpoint passthrough. */
import { randomUUID } from "crypto";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { enqueueLogEntry } from "../logs/entry.js";
import { CodexApiError } from "../proxy/codex-types.js";
import type { CodexAuxiliaryJsonPath, CodexAuxiliaryRequestContext, UpstreamAdapter } from "../proxy/upstream-adapter.js";
import { X_CODEX_BETA_FEATURES_HEADER, X_CODEX_PARENT_THREAD_ID_HEADER, X_CODEX_TURN_METADATA_HEADER, X_CODEX_WINDOW_ID_HEADER, X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER } from "../proxy/codex-request-context.js";
import { OPENAI_SUBAGENT_HEADER } from "../proxy/openai-subagent.js";
const SAFE = new Set(["cache-control", "content-language", "content-type", "etag", "last-modified", "location", "openai-processing-ms", "openai-version", "request-id", "retry-after", "x-openai-processing-ms", "x-openai-request-id", "x-request-id"]);
function headers(source: Headers): Headers { const out = new Headers(); source.forEach((v, k) => { const n = k.toLowerCase(); if (SAFE.has(n) || n.startsWith("ratelimit-") || n.startsWith("x-ratelimit-")) out.append(k, v); }); return out; }
function context(c: Context): CodexAuxiliaryRequestContext { const get = (name: string) => c.req.header(name)?.trim() || undefined; return { turnState: get("x-codex-turn-state"), turnMetadata: get(X_CODEX_TURN_METADATA_HEADER), betaFeatures: get(X_CODEX_BETA_FEATURES_HEADER), version: get("Version"), includeTimingMetrics: get(X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER), codexWindowId: get(X_CODEX_WINDOW_ID_HEADER), parentThreadId: get(X_CODEX_PARENT_THREAD_ID_HEADER), ...(get(OPENAI_SUBAGENT_HEADER) ? { client_metadata: { [OPENAI_SUBAGENT_HEADER]: get(OPENAI_SUBAGENT_HEADER)! } } : {}) }; }
export async function handleCodexAuxiliaryJson(options: { c: Context; upstream: UpstreamAdapter & Required<Pick<UpstreamAdapter, "forwardCodexJsonRequest">>; path: CodexAuxiliaryJsonPath; body: Record<string, unknown>; model: string }): Promise<Response> {
  const { c, upstream, path, body, model } = options; const requestId = c.get("requestId") ?? randomUUID().slice(0, 8); const started = Date.now(); let response: Response;
  try { response = await upstream.forwardCodexJsonRequest(path, body, c.req.raw.signal, context(c)); } catch (error) { const message = error instanceof Error ? error.message : "Upstream request failed"; const status = error instanceof CodexApiError && error.status >= 400 ? error.status : 502; enqueueLogEntry({ requestId, direction: "egress", method: "POST", path: `/v1/${path}`, model, provider: upstream.tag, status, latencyMs: Date.now() - started, stream: false, error: message, request: { model, endpoint: path } }); c.status((status >= 400 && status <= 599 ? status : 502) as StatusCode); return c.json({ error: { message, type: "server_error", code: "codex_auxiliary_upstream_error" } }); }
  enqueueLogEntry({ requestId, direction: "egress", method: "POST", path: `/v1/${path}`, model, provider: upstream.tag, status: response.status, latencyMs: Date.now() - started, stream: false, request: { model, endpoint: path } });
  return new Response([204, 205, 304].includes(response.status) ? null : response.body, { status: response.status, statusText: response.statusText, headers: headers(response.headers) });
}
