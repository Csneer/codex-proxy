import type { CodexResponsesRequest } from "./codex-types.js";
export const X_CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
export const X_CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
export const X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER = "x-responsesapi-include-timing-metrics";
export const X_CODEX_PARENT_THREAD_ID_HEADER = "x-codex-parent-thread-id";
export const X_CODEX_WINDOW_ID_HEADER = "x-codex-window-id";
export function nonEmptyString(value: string | null | undefined): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
export function firstCodexRequestString(request: CodexResponsesRequest, key: string): string | null {
  const direct = key === X_CODEX_TURN_METADATA_HEADER ? request.turnMetadata : key === X_CODEX_BETA_FEATURES_HEADER ? request.betaFeatures : key === X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER ? request.includeTimingMetrics : key === X_CODEX_PARENT_THREAD_ID_HEADER ? request.parentThreadId : key === X_CODEX_WINDOW_ID_HEADER ? request.codexWindowId : undefined;
  return nonEmptyString(direct) ?? nonEmptyString(request.client_metadata?.[key]);
}
export function applyCodexContextHeaders(headers: Record<string, string>, request: CodexResponsesRequest): void {
  if (request.turnState) headers["x-codex-turn-state"] = request.turnState;
  for (const key of [X_CODEX_TURN_METADATA_HEADER, X_CODEX_BETA_FEATURES_HEADER, X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER, X_CODEX_PARENT_THREAD_ID_HEADER]) { const value = firstCodexRequestString(request, key); if (value) headers[key] = value; }
  if (request.version?.trim()) headers.Version = request.version.trim();
}
export function buildCodexClientMetadata(request: CodexResponsesRequest, installationId: string, _sessionId?: string | null, windowId?: string | null): Record<string, string> {
  return { ...(request.client_metadata ?? {}), "x-codex-installation-id": installationId, ...(windowId ? { [X_CODEX_WINDOW_ID_HEADER]: windowId } : {}) };
}
export function codexVersionFromUserAgent(userAgent: string | undefined): string | null { const match = userAgent?.match(/\/(\d+\.\d+\.\d+)/); return match?.[1] ?? null; }
