import { randomUUID } from "node:crypto";
import { resolveCallContext } from "./context.js";
import { redactCallContent, serializeBounded } from "./redact.js";
import { getStreamResponseCaptureMetadata } from "./stream-response.js";
import type { CallRecordStore } from "./store.js";
import type {
  CallContextHints,
  CompletedCallRecord,
  CreatePendingCallInput,
  PendingCallRecord,
  SuccessfulCallResult,
} from "./types.js";

export interface CallRecorder {
  createPendingCall(input: CreatePendingCallInput): PendingCallRecord | undefined;
  finalizeSuccessfulCall(pending: PendingCallRecord | undefined, result: SuccessfulCallResult): boolean;
}

interface CallRecorderOptions {
  store: CallRecordStore;
  isEnabled: () => boolean;
  maxBodyBytes: () => number;
  now?: () => number;
  onError?: (error: unknown, requestId: string) => void;
}

function mergeContextHints(base: CallContextHints, extra?: Partial<CallContextHints>): CallContextHints {
  if (!extra) return base;
  return {
    ...base,
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined)),
    source: extra.source ?? base.source,
  };
}

function normalizeToken(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function createCallRecorder(options: CallRecorderOptions): CallRecorder {
  const now = options.now ?? Date.now;

  return {
    createPendingCall(input) {
      if (!options.isEnabled()) return undefined;
      const startedAtMs = now();
      return {
        ...input,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        maxBodyBytes: options.maxBodyBytes(),
        finalized: false,
      };
    },

    finalizeSuccessfulCall(pending, result) {
      if (!pending || pending.finalized) return false;
      pending.finalized = true;
      if (!options.isEnabled()) {
        pending.request = null;
        return false;
      }

      try {
        const completedAtMs = now();
        const maxBodyBytes = pending.maxBodyBytes;
        const request = serializeBounded(redactCallContent(pending.request), maxBodyBytes);
        const streamResponseMetadata = getStreamResponseCaptureMetadata(result.response);
        const response = serializeBounded(redactCallContent(result.response), maxBodyBytes);
        const usage = result.usage ?? {};
        const completed: CompletedCallRecord = {
          id: randomUUID(),
          requestId: pending.requestId,
          context: resolveCallContext(mergeContextHints(pending.contextHints, result.contextHints)),
          startedAt: pending.startedAt,
          completedAt: new Date(completedAtMs).toISOString(),
          latencyMs: Math.max(0, Math.trunc(completedAtMs - pending.startedAtMs)),
          route: pending.route,
          protocol: pending.protocol,
          provider: result.provider,
          accountId: result.accountId ?? null,
          model: pending.model,
          upstreamModel: result.upstreamModel ?? null,
          stream: pending.stream,
          responseId: result.responseId ?? null,
          inputTokens: normalizeToken(usage.input_tokens),
          outputTokens: normalizeToken(usage.output_tokens),
          cachedTokens: normalizeToken(usage.cached_tokens),
          reasoningTokens: normalizeToken(usage.reasoning_tokens),
          imageInputTokens: normalizeToken(usage.image_input_tokens),
          imageOutputTokens: normalizeToken(usage.image_output_tokens),
          requestJson: request.json,
          responseJson: response.json,
          requestBytes: request.originalBytes,
          responseBytes: streamResponseMetadata?.originalBytes ?? response.originalBytes,
          requestTruncated: request.truncated,
          responseTruncated: response.truncated || streamResponseMetadata?.truncated === true,
        };
        return options.store.insert(completed);
      } catch (error) {
        try {
          options.onError?.(error, pending.requestId);
        } catch {
          // Diagnostics must never alter an already successful proxy response.
        }
        return false;
      } finally {
        pending.request = null;
      }
    },
  };
}
