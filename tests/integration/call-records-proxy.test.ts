import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ConfigSchema } from "@src/config-schema.js";
import {
  closeCallRecordService,
  getCallRecordRecorder,
  getCallRecordStore,
  initializeCallRecordService,
} from "@src/call-records/service.js";
import { handleDirectRequest } from "@src/routes/shared/direct-request-handler.js";
import type {
  FormatAdapter,
  FormatStreamTranslatorOptions,
  ProxyRequest,
} from "@src/routes/shared/proxy-handler-types.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";

const dirs: string[] = [];

afterEach(() => {
  closeCallRecordService();
  vi.restoreAllMocks();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function initialize(maxBodyBytes = 4096) {
  const dir = mkdtempSync(join(tmpdir(), "call-record-proxy-"));
  dirs.push(dir);
  const config = ConfigSchema.parse({
    api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
    call_records: { enabled: true, max_body_bytes: maxBodyBytes },
  });
  initializeCallRecordService(config, join(dir, "calls.sqlite"));
}

function createRequest(requestId: string, stream: boolean, request: unknown): ProxyRequest {
  const callRecord = getCallRecordRecorder()!.createPendingCall({
    requestId,
    route: "/v1/responses",
    protocol: "responses",
    request,
    contextHints: {
      explicitSessionId: "session-1",
      explicitTaskId: "task-1",
      explicitCwd: "/workspace/project",
      source: "responses",
    },
    model: "gpt-5.4",
    stream,
  });
  return {
    codexRequest: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
    },
    model: "gpt-5.4",
    isStreaming: stream,
    callRecord,
  };
}

function createUpstream(): UpstreamAdapter {
  return {
    tag: "openai",
    createResponse: vi.fn(async () => new Response("")),
    async *parseStream() {},
  };
}

function createFormat(overrides: Partial<FormatAdapter> = {}): FormatAdapter {
  return {
    tag: "Responses",
    noAccountStatus: 503,
    formatNoAccount: () => ({ error: "no_account" }),
    format429: (message) => ({ error: message }),
    formatError: (status, message) => ({ error: { status, message } }),
    formatStreamError: (_status, message) => `event: response.failed\ndata: ${JSON.stringify({ error: message })}\n\n`,
    async *streamTranslator(options) {
      options.onUsage({ input_tokens: 12, output_tokens: 5 });
      options.onResponseId("response-stream");
      options.onResponseCompleted?.("response-stream");
      yield "event: response.completed\ndata: {\"response\":{\"id\":\"response-stream\"}}\n\n";
    },
    collectTranslator: vi.fn(async () => ({
      response: { id: "response-json", output_text: "done", email: "person@example.com" },
      usage: { input_tokens: 10, output_tokens: 4 },
      responseId: "response-json",
    })),
    ...overrides,
  };
}

function createTerminallyFailingFormat(): FormatAdapter {
  return createFormat({
    streamTranslator: vi.fn(async function* (options: FormatStreamTranslatorOptions) {
      options.onUsage({ input_tokens: 8, output_tokens: 1 });
      options.onResponseCompleted?.("response-failed");
      yield "event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n";
      throw new Error("upstream interrupted");
    }),
  });
}

function createApp(req: ProxyRequest, fmt: FormatAdapter): Hono {
  const app = new Hono();
  app.post("/v1/responses", (c) => {
    c.set("requestId", req.callRecord!.requestId);
    return handleDirectRequest({ c, upstream: createUpstream(), req, fmt });
  });
  return app;
}

describe("successful call persistence", () => {
  it("writes exactly one current success and no row for a terminal failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    initialize();

    const successfulRequest = createRequest("request-success", false, { prompt: "succeed" });
    const success = await createApp(successfulRequest, createFormat()).request("/v1/responses", {
      method: "POST",
    });
    expect(success.status).toBe(200);

    const failedRequest = createRequest("request-terminal-failure", true, { prompt: "fail" });
    const failure = await createApp(failedRequest, createTerminallyFailingFormat()).request("/v1/responses", {
      method: "POST",
    });
    await failure.text();

    const page = getCallRecordStore()!.list();
    expect(page.total).toBe(1);
    expect(page.records).toEqual([
      expect.objectContaining({ requestId: "request-success" }),
    ]);
  });

  it("persists one redacted non-streaming success with its context", async () => {
    initialize();
    const req = createRequest("request-json", false, {
      prompt: "hello",
      authorization: "Bearer secret-token-value-123456789",
    });

    const response = await createApp(req, createFormat()).request("/v1/responses", { method: "POST" });

    expect(response.status).toBe(200);
    const page = getCallRecordStore()!.list();
    expect(page.total).toBe(1);
    const detail = getCallRecordStore()!.get(page.records[0].id)!;
    expect(detail).toMatchObject({
      requestId: "request-json",
      sessionId: "session-1",
      taskId: "task-1",
      cwd: "/workspace/project",
      provider: "openai",
      inputTokens: 10,
      outputTokens: 4,
      responseId: "response-json",
    });
    expect(detail.requestJson).not.toContain("secret-token-value");
    expect(detail.responseJson).not.toContain("person@example.com");
  });

  it("persists one completed stream and preserves capture truncation", async () => {
    initialize(1024);
    const req = createRequest("request-stream", true, { prompt: "stream" });
    const fmt = createFormat({
      streamTranslator: vi.fn(async function* (options: FormatStreamTranslatorOptions) {
        options.onUsage({ input_tokens: 30, output_tokens: 20 });
        options.onResponseId("response-stream");
        options.onResponseCompleted?.("response-stream");
        yield `event: response.output_text.done\ndata: ${JSON.stringify({ text: "x".repeat(5000) })}\n\n`;
      }),
    });

    const response = await createApp(req, fmt).request("/v1/responses", { method: "POST" });
    await response.text();

    const page = getCallRecordStore()!.list();
    expect(page.total).toBe(1);
    const detail = getCallRecordStore()!.get(page.records[0].id)!;
    expect(detail).toMatchObject({
      requestId: "request-stream",
      stream: true,
      responseTruncated: true,
      inputTokens: 30,
      outputTokens: 20,
    });
    expect(Buffer.byteLength(detail.responseJson)).toBeLessThanOrEqual(1024);
  });

  it("does not persist a stream that fails after writing output", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    initialize();
    const req = createRequest("request-failed-stream", true, { prompt: "fail" });

    const response = await createApp(req, createTerminallyFailingFormat()).request("/v1/responses", { method: "POST" });
    await response.text();

    expect(getCallRecordStore()!.list().total).toBe(0);
  });
});
