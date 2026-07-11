import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOfficialAgentRoutes } from "@src/routes/official-agent.js";
import type {
  CodexAppServerBridge,
  CodexAppNotification,
  CodexAppTurnStreamEvent,
  StartThreadParams,
  StartTurnParams,
} from "@src/codex-app-server/types.js";
import { ConfigSchema } from "@src/config-schema.js";
import { resetConfigForTesting, setConfigForTesting } from "@src/config.js";
import {
  closeCallRecordService,
  getCallRecordStore,
  initializeCallRecordService,
} from "@src/call-records/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

class FakeBridge implements CodexAppServerBridge {
  public startedTurns: StartTurnParams[] = [];

  async listApps(): Promise<unknown> {
    return { data: [{ id: "chrome", name: "Chrome", isAccessible: true, isEnabled: true }], nextCursor: null };
  }

  async startThread(params: StartThreadParams): Promise<unknown> {
    return { thread: { id: params.model === "gpt-5.4" ? "thr_54" : "thr_default" } };
  }

  async startTurn(params: StartTurnParams): Promise<unknown> {
    this.startedTurns.push(params);
    return { turn: { id: "turn_1", status: "inProgress" } };
  }

  notificationsUntilTurnCompleted(): AsyncIterable<CodexAppNotification> {
    return (async function* () {
      yield { method: "item/agentMessage/delta", params: { delta: "ok" } };
      yield { method: "turn/completed", params: { turn: { id: "turn_1", status: "completed" } } };
    })();
  }

  async *runTurn(params: StartTurnParams): AsyncIterable<CodexAppTurnStreamEvent> {
    const result = await this.startTurn(params);
    yield { type: "result", result };
    for await (const notification of this.notificationsUntilTurnCompleted()) {
      yield { type: "notification", notification };
    }
  }

  async close(): Promise<void> {}
}

function makeApp(bridge: CodexAppServerBridge): Hono {
  const app = new Hono();
  app.route("/", createOfficialAgentRoutes(() => bridge));
  return app;
}

describe("official agent routes", () => {
  beforeEach(() => {
    resetConfigForTesting();
  });

  afterEach(() => {
    closeCallRecordService();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function enableCapture() {
    const config = ConfigSchema.parse({
      api: {}, client: {}, model: { default: "gpt-5.4" }, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true, api_key: "agent-key" },
      call_records: { enabled: true, max_body_bytes: 4096 },
    });
    setConfigForTesting(config);
    const dir = mkdtempSync(join(tmpdir(), "official-agent-records-"));
    dirs.push(dir);
    initializeCallRecordService(config, join(dir, "calls.sqlite"));
  }

  it("returns 503 when official agent bridge is disabled", async () => {
    setConfigForTesting(ConfigSchema.parse({ api: {}, client: {}, model: {}, auth: {}, server: {}, session: {} }));
    const res = await makeApp(new FakeBridge()).request("/official-agent/apps");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: "official_agent_disabled", message: "Official Codex app-server bridge is disabled" },
    });
  });

  it("requires official-agent API key when configured", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true, api_key: "agent-key" },
    }));

    const res = await makeApp(new FakeBridge()).request("/official-agent/apps");

    expect(res.status).toBe(401);
  });

  it("rejects official agent requests when the official-agent API key is not configured", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: { proxy_api_key: "proxy-key" }, session: {},
      official_agent: { enabled: true },
    }));

    const res = await makeApp(new FakeBridge()).request("/official-agent/apps");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "official_agent_requires_api_key",
        message: "Official Codex app-server bridge requires official_agent.api_key",
      },
    });
  });

  it("does not accept the general proxy API key for official-agent requests", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true, api_key: "agent-key" },
    }));

    const res = await makeApp(new FakeBridge()).request("/official-agent/apps", {
      headers: { Authorization: "Bearer proxy-key" },
    });

    expect(res.status).toBe(401);
  });

  it("lists apps through the app-server bridge", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true, api_key: "agent-key" },
    }));

    const res = await makeApp(new FakeBridge()).request("/official-agent/apps", {
      headers: { Authorization: "Bearer agent-key" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ id: "chrome", name: "Chrome", isAccessible: true, isEnabled: true }],
      nextCursor: null,
    });
  });

  it("starts a thread", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true, api_key: "agent-key" },
    }));

    const res = await makeApp(new FakeBridge()).request("/official-agent/threads", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer agent-key" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ thread: { id: "thr_54" } });
  });

  it("starts a turn and streams app-server notifications as SSE", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true, api_key: "agent-key" },
    }));
    const bridge = new FakeBridge();

    const res = await makeApp(bridge).request("/official-agent/threads/thr_54/turns", {
      method: "POST",
      body: JSON.stringify({ text: "Open the dashboard", app: { id: "chrome", name: "Chrome" } }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer agent-key" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(bridge.startedTurns).toEqual([{
      threadId: "thr_54",
      text: "Open the dashboard",
      app: { id: "chrome", name: "Chrome" },
    }]);
    const body = await res.text();
    expect(body).toContain("event: official_agent.result");
    expect(body).toContain("event: item/agentMessage/delta");
    expect(body).toContain("event: turn/completed");
  });

  it("persists only a completed turn with thread and cwd context", async () => {
    enableCapture();
    const bridge = new FakeBridge();
    bridge.notificationsUntilTurnCompleted = () => (async function* () {
      yield { method: "item/agentMessage/delta", params: { delta: "done" } };
      yield {
        method: "turn/completed",
        params: {
          turn: {
            id: "turn_success",
            status: "completed",
            usage: { input_tokens: 25, output_tokens: 9, cached_tokens: 4 },
          },
        },
      };
    })();

    const response = await makeApp(bridge).request("/official-agent/threads/thread_1/turns", {
      method: "POST",
      body: JSON.stringify({ text: "Inspect the app", cwd: "/workspace/app" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer agent-key" },
    });
    await response.text();

    const page = getCallRecordStore()!.list();
    expect(page.total).toBe(1);
    const detail = getCallRecordStore()!.get(page.records[0].id)!;
    expect(detail).toMatchObject({
      protocol: "official-agent",
      provider: "official-agent",
      model: "gpt-5.4",
      sessionId: "thread_1",
      taskId: "thread_1",
      cwd: "/workspace/app",
      responseId: "turn_success",
      inputTokens: 25,
      outputTokens: 9,
      cachedTokens: 4,
    });
    expect(detail.requestJson).toContain("Inspect the app");
    expect(detail.responseJson).toContain("item/agentMessage/delta");
    expect(detail.responseJson).not.toContain("event:");
  });

  it("does not persist a failed turn", async () => {
    enableCapture();
    const bridge = new FakeBridge();
    bridge.notificationsUntilTurnCompleted = () => (async function* () {
      yield { method: "item/agentMessage/delta", params: { delta: "partial" } };
      yield { method: "turn/failed", params: { turn: { id: "turn_failed", status: "failed" } } };
    })();

    const response = await makeApp(bridge).request("/official-agent/threads/thread_1/turns", {
      method: "POST",
      body: JSON.stringify({ text: "Inspect the app", cwd: "/workspace/app" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer agent-key" },
    });
    await response.text();

    expect(getCallRecordStore()!.list().total).toBe(0);
  });

  it("rejects unsupported approval policies", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true, api_key: "agent-key" },
    }));
    const bridge = new FakeBridge();

    const res = await makeApp(bridge).request("/official-agent/threads/thr_54/turns", {
      method: "POST",
      body: JSON.stringify({ text: "Open the dashboard", approvalPolicy: "always-approve" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer agent-key" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "approvalPolicy must be one of: untrusted, on-request, on-failure, never",
      },
    });
    expect(bridge.startedTurns).toEqual([]);
  });
});
