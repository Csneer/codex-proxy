import type { UsageInfo } from "../translation/codex-event-extractor.js";

export type CallProtocol = "openai" | "anthropic" | "gemini" | "responses" | "official-agent";

export interface CallContextHints {
  explicitSessionId?: string;
  explicitTaskId?: string;
  explicitCwd?: string;
  protocolSessionId?: string;
  protocolTaskId?: string;
  protocolCwd?: string;
  derivedConversationId?: string;
  source: string;
}

export interface ResolvedCallContext {
  sessionId: string | null;
  taskId: string | null;
  cwd: string | null;
  source: string;
  contextKey: string | null;
}

export interface PendingCallRecord {
  requestId: string;
  startedAt: string;
  startedAtMs: number;
  route: string;
  protocol: CallProtocol;
  request: unknown;
  contextHints: CallContextHints;
  model: string;
  stream: boolean;
  maxBodyBytes: number;
  finalized: boolean;
}

export interface CreatePendingCallInput {
  requestId: string;
  route: string;
  protocol: CallProtocol;
  request: unknown;
  contextHints: CallContextHints;
  model: string;
  stream: boolean;
}

export interface CompletedCallRecord {
  id: string;
  requestId: string;
  context: ResolvedCallContext;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  route: string;
  protocol: CallProtocol;
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
  imageInputTokens: number;
  imageOutputTokens: number;
  requestJson: string;
  responseJson: string;
  requestBytes: number;
  responseBytes: number;
  requestTruncated: boolean;
  responseTruncated: boolean;
}

export interface SuccessfulCallResult {
  response: unknown;
  usage?: Partial<UsageInfo>;
  provider: string;
  accountId?: string | null;
  upstreamModel?: string | null;
  responseId?: string | null;
  contextHints?: Partial<CallContextHints>;
}

export type CallRecordSort = "completed_at" | "latency_ms" | "input_tokens" | "output_tokens";
export type SortOrder = "asc" | "desc";

export interface CallRecordQuery {
  from?: string;
  to?: string;
  contextId?: string;
  sessionId?: string;
  taskId?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  accountId?: string;
  protocol?: CallProtocol;
  stream?: boolean;
  search?: string;
  sort?: CallRecordSort;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

export interface CallRecordSummary extends Omit<CompletedCallRecord, "context" | "requestJson" | "responseJson"> {
  contextId: string | null;
  sessionId: string | null;
  taskId: string | null;
  cwd: string | null;
  requestPreview: string;
  responsePreview: string;
}

export interface CallRecordDetail extends CallRecordSummary {
  contextSource: string | null;
  requestJson: string;
  responseJson: string;
}

export interface CallRecordPage {
  records: CallRecordSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CallContextQuery extends Omit<CallRecordQuery, "contextId" | "sort"> {
  sort?: "updated_at" | "call_count" | "input_tokens" | "output_tokens";
}

export interface CallContextSummary {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  cwd: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  firstCompletedAt: string;
  lastCompletedAt: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface CallContextPage {
  contexts: CallContextSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CallRecordStoreState {
  path: string;
  rowCount: number;
  contextCount: number;
  databaseBytes: number;
  searchMode: "fts5" | "like";
}

export type CallRangePreset = "today" | "24h" | "7d";
export interface CallRange {
  preset: CallRangePreset;
  timezone: string;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}
export interface CallOverview {
  range: Pick<CallRange, "preset" | "timezone" | "from" | "to">;
  generatedAt: string;
  success: { count: number; previousCount: number; lastCompletedAt: string | null };
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheRatio: number };
  storage: { permanentBytes: number; rawBytes: number; semanticLogicalBytes: number; rawLogicalBytes: number; indexBytes: number; walBytes: number; totalBytes: number; measurement: "sqlite-pages-and-logical-sums" };
  outcomes: { failure: number; interrupted: number; retry: number };
  series: Array<{ bucketStart: string; success: number }>;
  models: Array<{ model: string; count: number; share: number }>;
  protocols: Array<{ protocol: string; count: number; share: number }>;
  contexts: CallContextSummary[];
  sections: Record<string, { error?: string }>;
}
