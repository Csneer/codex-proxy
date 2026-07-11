import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const store = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  listContexts: vi.fn(),
  getState: vi.fn(),
  clear: vi.fn(),
}));
const service = vi.hoisted(() => ({ current: store as typeof store | null }));
const config = vi.hoisted(() => ({
  call_records: { enabled: true, retention_days: null, max_body_bytes: 4096 },
}));

vi.mock("@src/call-records/service.js", () => ({
  getCallRecordStore: () => service.current,
}));

vi.mock("@src/config.js", () => ({
  getConfig: () => config,
}));

import { createCallRecordRoutes } from "@src/routes/admin/call-records.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/", createCallRecordRoutes());
  return app;
}

describe("call record admin routes", () => {
  beforeEach(() => {
    service.current = store;
    store.list.mockReset().mockReturnValue({ records: [], total: 0, limit: 50, offset: 0 });
    store.get.mockReset();
    store.listContexts.mockReset().mockReturnValue({ contexts: [], total: 0, limit: 50, offset: 0 });
    store.getState.mockReset().mockReturnValue({
      path: "/data/call-records.sqlite",
      rowCount: 2,
      contextCount: 1,
      databaseBytes: 8192,
      searchMode: "fts5",
    });
    store.clear.mockReset();
  });

  it("passes validated list filters to the store", async () => {
    const response = await makeApp().request(
      "/admin/call-records?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-31T00%3A00%3A00.000Z" +
      "&context_id=context-1&session_id=session-1&task_id=task-1&cwd=%2Frepo&model=gpt-5.4" +
      "&provider=codex&account_id=account-1&protocol=responses&stream=true&search=hello" +
      "&sort=input_tokens&order=asc&limit=20&offset=40",
    );

    expect(response.status).toBe(200);
    expect(store.list).toHaveBeenCalledWith({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-31T00:00:00.000Z",
      contextId: "context-1",
      sessionId: "session-1",
      taskId: "task-1",
      cwd: "/repo",
      model: "gpt-5.4",
      provider: "codex",
      accountId: "account-1",
      protocol: "responses",
      stream: true,
      search: "hello",
      sort: "input_tokens",
      order: "asc",
      limit: 20,
      offset: 40,
    });
  });

  it("rejects invalid list filters without querying", async () => {
    const invalidQueries = [
      "limit=201",
      "offset=-1",
      "stream=yes",
      "protocol=unknown",
      "sort=request_json",
      "order=random",
      "from=not-a-date",
    ];
    for (const query of invalidQueries) {
      const response = await makeApp().request(`/admin/call-records?${query}`);
      expect(response.status, query).toBe(400);
    }
    expect(store.list).not.toHaveBeenCalled();
  });

  it("returns detail and 404 for a missing record", async () => {
    store.get.mockReturnValueOnce({ id: "record-1", requestJson: "{}", responseJson: "{}" });
    const found = await makeApp().request("/admin/call-records/record-1");
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ id: "record-1" });

    store.get.mockReturnValueOnce(null);
    const missing = await makeApp().request("/admin/call-records/missing");
    expect(missing.status).toBe(404);
  });

  it("returns grouped contexts with validated sorting", async () => {
    const response = await makeApp().request(
      "/admin/call-contexts?provider=codex&sort=call_count&order=desc&limit=10&offset=0",
    );
    expect(response.status).toBe(200);
    expect(store.listContexts).toHaveBeenCalledWith({
      provider: "codex",
      sort: "call_count",
      order: "desc",
      limit: 10,
      offset: 0,
    });

    expect((await makeApp().request("/admin/call-contexts?sort=latency_ms")).status).toBe(400);
  });

  it("reports configuration with store state and clears records", async () => {
    const stateResponse = await makeApp().request("/admin/call-records/state");
    expect(await stateResponse.json()).toEqual({
      enabled: true,
      retentionDays: null,
      maxBodyBytes: 4096,
      path: "/data/call-records.sqlite",
      rowCount: 2,
      contextCount: 1,
      databaseBytes: 8192,
      searchMode: "fts5",
    });

    const clearResponse = await makeApp().request("/admin/call-records/clear", { method: "POST" });
    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toEqual({ ok: true });
    expect(store.clear).toHaveBeenCalledOnce();
  });

  it("returns 503 while the store is unavailable", async () => {
    service.current = null;
    for (const [method, path] of [
      ["GET", "/admin/call-records"],
      ["GET", "/admin/call-records/state"],
      ["GET", "/admin/call-contexts"],
      ["POST", "/admin/call-records/clear"],
    ] as const) {
      const response = await makeApp().request(path, { method });
      expect(response.status, path).toBe(503);
    }
  });
});
