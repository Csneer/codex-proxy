/**
 * Direct upstream handler for API-key-based upstreams (OpenAI, Anthropic,
 * Gemini, custom). This path has no account pool management, no session
 * affinity, and no retry logic; it only proxies the translated request and
 * translates the upstream response back to the route format.
 */

import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { CodexApiError } from "../../proxy/codex-api.js";
import { randomUUID } from "crypto";
import { enqueueLogEntry, updateLogEntry } from "../../logs/entry.js";
import { calculateLogMetrics } from "../../logs/metrics.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import { streamResponse } from "./response-processor.js";
import { toErrorStatus } from "./proxy-error-handler.js";
import type { HandleDirectRequestOptions } from "./proxy-handler-types.js";
import { canReturnStreamError, streamErrorResponse } from "./stream-error-response.js";
import { completeCallRecord } from "../../call-records/capture.js";
import { createStreamResponseCapture } from "../../call-records/stream-response.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

export async function handleDirectRequest(options: HandleDirectRequestOptions): Promise<Response> {
  const { c, upstream, req, fmt } = options;
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  const startMs = Date.now();
  let rawResponse: Response;
  try {
    rawResponse = await upstream.createResponse(req.codexRequest, abortController.signal);
    enqueueLogEntry({
      requestId,
      direction: "egress",
      method: "POST",
      path: "/v1/responses",
      model: req.model,
      provider: upstream.tag,
      status: rawResponse.status,
      latencyMs: Date.now() - startMs,
      stream: req.isStreaming,
      request: {
        model: req.codexRequest.model,
        stream: req.codexRequest.stream,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upstream request failed";
    const status = err instanceof CodexApiError ? err.status : 502;
    enqueueLogEntry({
      requestId,
      direction: "egress",
      method: "POST",
      path: "/v1/responses",
      model: req.model,
      provider: upstream.tag,
      status,
      latencyMs: Date.now() - startMs,
      stream: req.isStreaming,
      error: msg,
      request: {
        model: req.codexRequest.model,
        stream: req.codexRequest.stream,
      },
    });
    if (err instanceof CodexApiError) {
      const code = toErrorStatus(err.status) as StatusCode;
      if (canReturnStreamError(req, fmt)) {
        return streamErrorResponse(c, fmt, code, err.message);
      }
      c.status(code);
      // For API-key upstreams, forward the raw upstream error body transparently.
      try {
        const parsed: unknown = JSON.parse(err.body);
        if (parsed && typeof parsed === "object") {
          return c.json(parsed);
        }
      } catch { /* non-JSON body: fall through */ }
      if (code === 429) {
        return c.json(fmt.format429(err.message));
      }
      return c.json(fmt.formatError(code, err.message));
    }
    if (canReturnStreamError(req, fmt)) {
      return streamErrorResponse(c, fmt, 502, msg);
    }
    c.status(502);
    return c.json(fmt.formatError(502, msg));
  }

  if (req.isStreaming) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    // Disable response buffering on nginx-class reverse proxies so SSE
    // heartbeats and deltas reach the client immediately.
    c.header("X-Accel-Buffering", "no");

    return stream(c, async (s) => {
      const streamStartMs = Date.now();
      let firstTokenMs: number | null = null;
      let usageInfo: UsageInfo | null = null;
      let usage: UsageInfo | undefined;
      let responseId: string | null = null;
      let responseCompleted = false;
      const responseCapture = createStreamResponseCapture(req.callRecord?.maxBodyBytes ?? 1_048_576);
      s.onAbort(() => {
        console.warn(`[stream-client-abort] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}`);
        recordStreamCloseEvent({
          kind: "client-abort",
          requestId,
          tag: fmt.tag,
          provider: upstream.tag,
          path: "/v1/responses",
          model: req.model,
        });
        abortController.abort();
      });
      const result = await streamResponse({
        writer: s,
        api: upstream,
        response: rawResponse,
        model: req.model,
        adapter: fmt,
        onUsage: (value) => { usage = value; usageInfo = value; },
        onFirstToken: (ts) => { firstTokenMs = ts; },
        tupleSchema: req.tupleSchema,
        onResponseId: (value) => { responseId = value; },
        onResponseCompleted: (value) => {
          if (value) responseId = value;
          responseCompleted = true;
        },
        onChunkWritten: (chunk) => responseCapture.appendWrittenChunk(chunk),
        diagnostics: {
          requestId: requestId.slice(0, 8),
          tag: fmt.tag,
          provider: upstream.tag,
          path: "/v1/responses",
          abortSignal: abortController.signal,
        },
      });
      const metrics = calculateLogMetrics({ startMs: streamStartMs, firstTokenMs, endMs: Date.now(), model: req.model, usage: usageInfo, isStreaming: true });
      c.set("metrics", metrics);
      updateLogEntry(requestId, { status: rawResponse.status, latencyMs: metrics.durationMs, ttftMs: metrics.ttftMs, durationMs: metrics.durationMs, costUsd: metrics.costUsd, tokensPerSecond: metrics.tokensPerSecond, usage: usageInfo, metrics });
      if (result.completed && responseCompleted && usage) {
        completeCallRecord(req.callRecord, {
          response: responseCapture.finish(),
          usage,
          provider: upstream.tag,
          upstreamModel: req.codexRequest.model,
          responseId,
        });
      }
    });
  }

  try {
    const result = await fmt.collectTranslator({
      api: upstream,
      response: rawResponse,
      model: req.model,
      tupleSchema: req.tupleSchema,
    });
    completeCallRecord(req.callRecord, {
      response: result.response,
      usage: result.usage,
      provider: upstream.tag,
      upstreamModel: req.codexRequest.model,
      responseId: result.responseId,
    });
    const metrics = calculateLogMetrics({ startMs, endMs: Date.now(), model: req.model, usage: result.usage, isStreaming: false });
    c.set("metrics", metrics);
    updateLogEntry(requestId, { status: rawResponse.status, latencyMs: metrics.durationMs, ttftMs: metrics.ttftMs, durationMs: metrics.durationMs, costUsd: metrics.costUsd, tokensPerSecond: metrics.tokensPerSecond, usage: result.usage, metrics });
    return c.json(result.response);
  } catch (err) {
    abortController.abort();
    const msg = err instanceof Error ? err.message : "Failed to collect upstream response";
    const code = toErrorStatus(0) as StatusCode;
    c.status(code);
    return c.json(fmt.formatError(code, msg));
  }
}
