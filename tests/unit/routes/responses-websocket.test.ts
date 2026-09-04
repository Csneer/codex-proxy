/**
 * Integration-style unit tests for client-facing WebSocket support on
 * `/v1/responses`. A real HTTP server and `ws` client exercise the upgrade,
 * authentication, frame dispatch, SSE conversion, and shutdown path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Hono } from "hono";
import type { HandleProxyRequestOptions } from "@src/routes/shared/proxy-handler-types.js";

const mockConfig = {
  server: { proxy_api_key: null as string | null, trust_proxy: false },
  model: {
    default: "gpt-5.3-codex",
    default_reasoning_effort: null as string | null,
    default_service_tier: null as string | null,
    suppress_desktop_directives: false,
  },
  auth: {
    jwt_token: undefined as string | undefined,
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-responses-ws"),
  getConfigDir: vi.fn(() => "/tmp/test-responses-ws-config"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn(
      (_path: string, _data: string, _encoding: string, callback: (err: Error | null) => void) =>
        callback(null),
    ),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => ""),
  },
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => null),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
}));

vi.mock("@src/utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

let capturedCodexRequest: unknown = null;
let requestedStreams = 0;

function makeSseResponse(sseText: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

vi.mock("@src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (options: HandleProxyRequestOptions) => {
    capturedCodexRequest = options.req.codexRequest;
    requestedStreams++;
    return makeSseResponse(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi there"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
    );
  }),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { createResponsesRoutes } from "@src/routes/responses.js";
import { ResponsesWebSocketServer } from "@src/routes/responses-websocket.js";

const RESPONSE_CREATE_BODY = JSON.stringify({
  model: "codex",
  input: [{ role: "user", content: "Hello" }],
  stream: true,
});

function connectWithHeaders(
  port: number,
  headers: Record<string, string> = {},
  path = "/v1/responses",
): Promise<{ ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => reject({ status: res.statusCode }));
    ws.once("error", reject);
  });
}

function connectClient(port: number, authHeader?: string): Promise<{ ws: WebSocket }> {
  return connectWithHeaders(
    port,
    authHeader ? { Authorization: authHeader } : {},
  );
}

function receiveJsonFrames(ws: WebSocket, count: number): Promise<unknown[]> {
  const frames: unknown[] = [];
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      try {
        frames.push(JSON.parse(raw));
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (frames.length >= count) {
        cleanup();
        resolve(frames);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`socket closed after ${frames.length}/${count} frames`));
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}

describe("client-facing WebSocket on /v1/responses", () => {
  let pool: AccountPool;
  let app: Hono;
  let server: Server;
  let wsServer: ResponsesWebSocketServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedCodexRequest = null;
    requestedStreams = 0;
    mockConfig.server.proxy_api_key = null;

    loadStaticModels();
    pool = new AccountPool();
    pool.addAccount("test-token-1");
    app = createResponsesRoutes(pool);

    server = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    }) as unknown as Server;
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;

    wsServer = new ResponsesWebSocketServer({ server, app, accountPool: pool });
  });

  afterEach(async () => {
    await wsServer?.close();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    pool?.destroy();
  });

  it("accepts a WebSocket upgrade with the configured proxy key", async () => {
    mockConfig.server.proxy_api_key = "master-key";
    const { ws } = await connectClient(port, "Bearer master-key");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rejects an unauthenticated upgrade when a proxy key is configured", async () => {
    mockConfig.server.proxy_api_key = "master-key";
    await expect(connectClient(port)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an upgrade with an invalid proxy key", async () => {
    mockConfig.server.proxy_api_key = "master-key";
    await expect(connectClient(port, "Bearer wrong-key")).rejects.toMatchObject({ status: 401 });
  });

  it("accepts x-api-key and query-string key authentication", async () => {
    mockConfig.server.proxy_api_key = "master-key";

    const headerClient = await connectWithHeaders(port, { "x-api-key": "master-key" });
    expect(headerClient.ws.readyState).toBe(WebSocket.OPEN);
    headerClient.ws.close();

    const queryClient = await connectWithHeaders(port, {}, "/v1/responses?key=master-key");
    expect(queryClient.ws.readyState).toBe(WebSocket.OPEN);
    queryClient.ws.close();
  });

  it("dispatches response.create and streams SSE events as WS JSON frames", async () => {
    const { ws } = await connectClient(port);
    const received = receiveJsonFrames(ws, 3);
    ws.send(RESPONSE_CREATE_BODY);
    const frames = await received;

    expect(requestedStreams).toBe(1);
    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.model).toBe("gpt-5.3-codex");
    expect(req.stream).toBe(true);
    expect(req.useWebSocket).toBe(true);
    expect(frames).toEqual([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "Hi there" },
      { type: "response.completed", response: { id: "resp_1" } },
    ]);
    ws.close();
  });

  it("preserves query-string authentication when dispatching the synthetic POST", async () => {
    mockConfig.server.proxy_api_key = "master-key";
    const { ws } = await connectWithHeaders(port, {}, "/v1/responses?key=master-key");
    const received = receiveJsonFrames(ws, 3);
    ws.send(RESPONSE_CREATE_BODY);
    await received;
    expect(requestedStreams).toBe(1);
    ws.close();
  });

  it("supports sequential response.create frames on one socket", async () => {
    const { ws } = await connectClient(port);

    const first = receiveJsonFrames(ws, 3);
    ws.send(RESPONSE_CREATE_BODY);
    await first;

    const second = receiveJsonFrames(ws, 3);
    ws.send(JSON.stringify({
      model: "codex",
      input: [{ role: "user", content: "again" }],
      stream: true,
      previous_response_id: "resp_1",
    }));
    const frames = await second;

    expect(requestedStreams).toBe(2);
    expect((capturedCodexRequest as Record<string, unknown>).previous_response_id).toBe("resp_1");
    expect(frames).toHaveLength(3);
    ws.close();
  });

  it("keeps HTTP POST + SSE working while the WS server is attached", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: RESPONSE_CREATE_BODY,
    });

    expect(res.status).toBe(200);
    expect(await new Response(res.body).text()).toContain("event: response.created");
  });

  it("forwards non-SSE responses as typed error frames", async () => {
    const { handleProxyRequest } = await import("@src/routes/shared/proxy-handler.js");
    const mock = handleProxyRequest as ReturnType<typeof vi.fn>;
    mock.mockImplementationOnce(async () => new Response(
      JSON.stringify({
        type: "error",
        error: { type: "server_error", code: "no_available_accounts", message: "No accounts" },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));

    const { ws } = await connectClient(port);
    const received = receiveJsonFrames(ws, 1);
    ws.send(RESPONSE_CREATE_BODY);
    const [frame] = await received;

    expect(frame).toEqual({
      type: "error",
      error: { type: "server_error", code: "no_available_accounts", message: "No accounts" },
    });
    ws.close();
  });

  it("normalizes an OpenAI-style error response to a typed error frame", async () => {
    const { handleProxyRequest } = await import("@src/routes/shared/proxy-handler.js");
    const mock = handleProxyRequest as ReturnType<typeof vi.fn>;
    mock.mockImplementationOnce(async () => new Response(
      JSON.stringify({
        error: { message: "Invalid API key provided", type: "invalid_request_error", code: "invalid_api_key" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));

    const { ws } = await connectClient(port);
    const received = receiveJsonFrames(ws, 1);
    ws.send(RESPONSE_CREATE_BODY);
    const [frame] = await received;

    expect(frame).toEqual({
      type: "error",
      error: { type: "invalid_request_error", code: "invalid_api_key", message: "Invalid API key provided" },
    });
    ws.close();
  });

  it("returns a structured connection_busy error for a frame sent mid-flight", async () => {
    const { handleProxyRequest } = await import("@src/routes/shared/proxy-handler.js");
    const mock = handleProxyRequest as ReturnType<typeof vi.fn>;
    mock.mockImplementationOnce(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
          ));
          // Keep the first stream open so the connection remains busy.
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    const { ws } = await connectClient(port);
    const first = receiveJsonFrames(ws, 1);
    ws.send(RESPONSE_CREATE_BODY);
    await first;

    const busy = receiveJsonFrames(ws, 1);
    ws.send(RESPONSE_CREATE_BODY);
    const [frame] = await busy;

    expect(frame).toEqual({
      type: "error",
      error: {
        type: "server_error",
        code: "connection_busy",
        message: "A response.create is already in progress on this connection",
      },
    });
    ws.close();
  });
});
