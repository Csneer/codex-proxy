import { randomUUID, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { getConfig } from "../config.js";
import { CodexAppServerClient } from "../codex-app-server/client.js";
import { beginCallRecord, completeCallRecord } from "../call-records/capture.js";
import { createStreamResponseCapture } from "../call-records/stream-response.js";
import type {
  CodexAppNotification,
  CodexAppServerBridge,
  CodexAppTurnStreamEvent,
  OfficialAgentApprovalPolicy,
  StartThreadParams,
  StartTurnAppMention,
  StartTurnParams,
} from "../codex-app-server/types.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";
import { isRecord } from "../translation/shared-utils.js";

type BridgeFactory = () => CodexAppServerBridge;

let sharedBridge: CodexAppServerBridge | null = null;

function getSharedBridge(): CodexAppServerBridge {
  if (sharedBridge) return sharedBridge;
  const config = getConfig();
  sharedBridge = new CodexAppServerClient({
    url: config.official_agent.app_server_url,
    auth: config.official_agent.auth,
    requestTimeoutMs: config.official_agent.request_timeout_ms,
    clientInfo: {
      name: "codex_proxy",
      title: "Codex Proxy",
      version: "2.0.69",
    },
  });
  return sharedBridge;
}

export async function closeOfficialAgentBridgeForTesting(): Promise<void> {
  await sharedBridge?.close();
  sharedBridge = null;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function isAuthorized(authHeader: string | undefined, expectedKey: string | null): boolean {
  if (!expectedKey) return false;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseStartThread(body: unknown): StartThreadParams {
  if (!isRecord(body)) return {};
  return {
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
  };
}

function parseAppMention(value: unknown): StartTurnAppMention | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

const APPROVAL_POLICIES: readonly OfficialAgentApprovalPolicy[] = ["untrusted", "on-request", "on-failure", "never"];

function isApprovalPolicy(value: string): value is OfficialAgentApprovalPolicy {
  return APPROVAL_POLICIES.includes(value as OfficialAgentApprovalPolicy);
}

type ParseStartTurnResult =
  | { ok: true; params: StartTurnParams }
  | { ok: false; message: string };

function parseStartTurn(threadId: string, body: unknown): ParseStartTurnResult {
  if (!isRecord(body) || typeof body.text !== "string" || body.text.trim() === "") {
    return { ok: false, message: "text is required" };
  }
  if (body.approvalPolicy !== undefined) {
    if (typeof body.approvalPolicy !== "string" || !isApprovalPolicy(body.approvalPolicy)) {
      return { ok: false, message: `approvalPolicy must be one of: ${APPROVAL_POLICIES.join(", ")}` };
    }
  }
  const app = parseAppMention(body.app);
  return { ok: true, params: {
    threadId,
    text: body.text,
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    ...(body.approvalPolicy !== undefined ? { approvalPolicy: body.approvalPolicy } : {}),
    ...(app ? { app } : {}),
  } };
}

function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function encodeTurnEvent(event: CodexAppTurnStreamEvent): string {
  return event.type === "result"
    ? encodeSse("official_agent.result", event.result)
    : encodeSse(event.notification.method, event.notification);
}

function completedTurn(notification: CodexAppNotification): Record<string, unknown> | null {
  if (notification.method !== "turn/completed" || !isRecord(notification.params)) return null;
  return isRecord(notification.params.turn) ? notification.params.turn : notification.params;
}

function usageValue(usage: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function extractTurnUsage(turn: Record<string, unknown>): Partial<UsageInfo> | undefined {
  const usage = isRecord(turn.usage) ? turn.usage : null;
  if (!usage) return undefined;
  const result: Partial<UsageInfo> = {
    input_tokens: usageValue(usage, "input_tokens", "inputTokens"),
    output_tokens: usageValue(usage, "output_tokens", "outputTokens"),
    cached_tokens: usageValue(usage, "cached_tokens", "cachedTokens"),
    reasoning_tokens: usageValue(usage, "reasoning_tokens", "reasoningTokens"),
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

export function createOfficialAgentRoutes(bridgeFactory: BridgeFactory = getSharedBridge): Hono {
  const app = new Hono();

  app.use("/official-agent/*", async (c, next) => {
    const config = getConfig();
    if (!config.official_agent.enabled) {
      c.status(503);
      return c.json(errorBody("official_agent_disabled", "Official Codex app-server bridge is disabled"));
    }
    const apiKey = config.official_agent.api_key;
    if (!apiKey) {
      c.status(403);
      return c.json(errorBody("official_agent_requires_api_key", "Official Codex app-server bridge requires official_agent.api_key"));
    }
    if (!isAuthorized(c.req.header("Authorization"), apiKey)) {
      c.status(401);
      return c.json(errorBody("invalid_api_key", "Invalid official-agent API key"));
    }
    await next();
  });

  app.get("/official-agent/apps", async (c) => {
    const cursor = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const result = await bridgeFactory().listApps({
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined && Number.isInteger(limit) ? { limit } : {}),
    });
    return c.json(result);
  });

  app.post("/official-agent/threads", async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const result = await bridgeFactory().startThread(parseStartThread(body));
    return c.json(result);
  });

  app.post("/official-agent/threads/:threadId/turns", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(errorBody("invalid_json", "Malformed JSON request body"));
    }

    const parsed = parseStartTurn(c.req.param("threadId"), body);
    if (!parsed.ok) {
      c.status(400);
      return c.json(errorBody("invalid_request", parsed.message));
    }

    const config = getConfig();
    const requestId = c.get("requestId") ?? randomUUID();
    const pending = beginCallRecord({
      requestId,
      route: c.req.path,
      protocol: "official-agent",
      request: body,
      headers: c.req.raw.headers,
      model: config.model.default,
      stream: true,
      contextHints: {
        protocolSessionId: parsed.params.threadId,
        protocolTaskId: parsed.params.threadId,
        protocolCwd: parsed.params.cwd,
        source: "official-agent",
      },
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const responseCapture = createStreamResponseCapture(pending?.maxBodyBytes ?? 1_048_576);
        let terminalTurn: Record<string, unknown> | null = null;
        try {
          for await (const event of bridgeFactory().runTurn(parsed.params)) {
            const chunk = encodeTurnEvent(event);
            controller.enqueue(encoder.encode(chunk));
            responseCapture.appendWrittenChunk(chunk);
            if (event.type === "notification") {
              terminalTurn = completedTurn(event.notification) ?? terminalTurn;
            }
          }
          if (terminalTurn) {
            completeCallRecord(pending, {
              response: responseCapture.finish(),
              usage: extractTurnUsage(terminalTurn),
              provider: "official-agent",
              upstreamModel: config.model.default,
              responseId: typeof terminalTurn.id === "string" ? terminalTurn.id : null,
            });
          }
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(encodeSse("official_agent.error", errorBody("app_server_error", message))));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
