import Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CallRecordStore } from "@src/call-records/store.js";
import type { CompletedCallRecord } from "@src/call-records/types.js";
import { createSchemaV1Database } from "@fixtures/call-records/schema-v1.js";

const tempDirs: string[] = [];
const stores: CallRecordStore[] = [];

function createStore(options: { forceSearchMode?: "like" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "call-records-"));
  tempDirs.push(dir);
  const path = join(dir, "records.sqlite");
  const store = new CallRecordStore({ path, ...options });
  stores.push(store);
  return { store, path };
}

function record(overrides: Partial<CompletedCallRecord> = {}): CompletedCallRecord {
  const requestId = overrides.requestId ?? "request-1";
  return {
    id: `id-${requestId}`,
    requestId,
    context: {
      sessionId: "session-a",
      taskId: "task-a",
      cwd: "/repo/a",
      source: "responses",
      contextKey: "context-a",
    },
    startedAt: "2026-07-11T00:00:00.000Z",
    completedAt: "2026-07-11T00:00:01.000Z",
    latencyMs: 1000,
    route: "/v1/responses",
    protocol: "responses",
    provider: "codex",
    accountId: "account-a",
    model: "gpt-5.4",
    upstreamModel: null,
    stream: false,
    responseId: `response-${requestId}`,
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 10,
    reasoningTokens: 5,
    imageInputTokens: 0,
    imageOutputTokens: 0,
    requestJson: JSON.stringify({ prompt: `request text ${requestId}` }),
    responseJson: JSON.stringify({ text: `response text ${requestId}` }),
    requestBytes: 30,
    responseBytes: 40,
    requestTruncated: false,
    responseTruncated: false,
    ...overrides,
  };
}

function seed(store: CallRecordStore): CompletedCallRecord[] {
  const records = [
    record({ requestId: "r1" }),
    record({ requestId: "r2", completedAt: "2026-07-12T00:00:00.000Z", model: "gpt-5.5", provider: "openai", accountId: "account-b", protocol: "openai", stream: true, inputTokens: 200, outputTokens: 30, requestJson: JSON.stringify({ prompt: "needle alpha" }) }),
    record({ requestId: "r3", completedAt: "2026-07-13T00:00:00.000Z", context: { sessionId: "session-b", taskId: "task-b", cwd: "/repo/b", source: "claude", contextKey: "context-b" }, provider: "anthropic", protocol: "anthropic", accountId: null, latencyMs: 3000, inputTokens: 300, outputTokens: 40, responseJson: JSON.stringify({ text: "needle beta" }) }),
    record({ requestId: "r4", completedAt: "2026-07-14T00:00:00.000Z", context: { sessionId: "session-b", taskId: "task-b", cwd: "/repo/b", source: "claude", contextKey: "context-b" }, model: "gemini-2.5-pro", provider: "gemini", protocol: "gemini", accountId: "account-c", inputTokens: 400, outputTokens: 50 }),
    record({ requestId: "r5", completedAt: "2026-07-15T00:00:00.000Z", context: { sessionId: null, taskId: null, cwd: "/repo/c", source: "official-agent", contextKey: "context-c" }, protocol: "official-agent", provider: "codex", accountId: "account-a", inputTokens: 500, outputTokens: 60 }),
    record({ requestId: "r6", completedAt: "2026-07-16T00:00:00.000Z", context: { sessionId: null, taskId: null, cwd: null, source: "responses", contextKey: null }, stream: true, inputTokens: 600, outputTokens: 70 }),
  ];
  for (const item of records) expect(store.insert(item)).toBe(true);
  return records;
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("CallRecordStore schema and insert", () => {
  it("opens a schema-v1 database without losing stable metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "call-records-v1-"));
    tempDirs.push(dir);
    const path = join(dir, "records.sqlite");
    createSchemaV1Database(path);

    const legacyDb = new Database(path);
    expect(legacyDb.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(legacyDb.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(legacyDb.pragma("user_version", { simple: true })).toBe(1);
    const objects = legacyDb.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger')
    `).all() as Array<{ name: string }>;
    const objectNames = objects.map(({ name }) => name);
    expect(objectNames).toEqual(expect.arrayContaining([
      "call_contexts",
      "call_records",
      "idx_call_records_completed_at",
      "idx_call_records_context_id",
      "idx_call_records_model",
      "idx_call_records_provider",
      "idx_call_records_account_id",
      "idx_call_records_protocol",
      "idx_call_records_completed_model",
      "call_records_fts",
      "call_records_fts_insert",
      "call_records_fts_delete",
      "call_records_fts_update",
    ]));
    const contextTable = legacyDb.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'call_contexts'
    `).get() as { sql: string };
    expect(contextTable.sql).toContain("CHECK (session_id IS NOT NULL OR task_id IS NOT NULL OR cwd IS NOT NULL)");
    expect(legacyDb.prepare("SELECT * FROM call_contexts WHERE id = ?").get("ctx-1")).toEqual({
      id: "ctx-1",
      context_key: "hash-1",
      session_id: "session-1",
      task_id: "task-1",
      cwd: "/repo",
      source: "proxy_headers",
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:01:00.000Z",
    });
    expect(legacyDb.prepare(`
      SELECT rowid FROM call_records_fts WHERE call_records_fts MATCH ?
    `).get("legacy")).toEqual({ rowid: 1 });
    expect(legacyDb.pragma("foreign_key_list(call_records)")).toEqual([
      expect.objectContaining({
        table: "call_contexts",
        from: "context_id",
        to: "id",
        on_delete: "SET NULL",
      }),
    ]);
    legacyDb.pragma("foreign_keys = ON");
    legacyDb.exec("BEGIN");
    legacyDb.prepare("DELETE FROM call_contexts WHERE id = ?").run("ctx-1");
    expect(legacyDb.prepare("SELECT context_id FROM call_records WHERE id = ?").get("call-1"))
      .toEqual({ context_id: null });
    legacyDb.exec("ROLLBACK");
    legacyDb.close();

    const store = new CallRecordStore({ path });
    stores.push(store);

    const detail = store.get("call-1");
    expect(detail).toMatchObject({
      id: "call-1",
      requestId: "request-1",
      contextId: "ctx-1",
      sessionId: "session-1",
      taskId: "task-1",
      cwd: "/repo",
      contextSource: "proxy_headers",
      startedAt: "2026-07-18T00:00:00.000Z",
      completedAt: "2026-07-18T00:01:00.000Z",
      latencyMs: 60_000,
      route: "/v1/responses",
      protocol: "responses",
      provider: "codex",
      accountId: "account-1",
      model: "gpt-5.6-sol",
      upstreamModel: "gpt-5.6-sol",
      stream: true,
      responseId: "resp-1",
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 80,
      reasoningTokens: 5,
      imageInputTokens: 0,
      imageOutputTokens: 0,
      requestBytes: 80,
      responseBytes: 96,
      requestTruncated: false,
      responseTruncated: false,
    });
    expect(JSON.parse(detail!.requestJson)).toEqual({
      input: [{ role: "user", content: "legacy question" }],
    });
    expect(JSON.parse(detail!.responseJson)).toEqual([
      { event: "response.completed", data: { output_text: "legacy answer" } },
    ]);
    expect(store.listContexts().contexts).toEqual([
      expect.objectContaining({
        id: "ctx-1",
        sessionId: "session-1",
        taskId: "task-1",
        cwd: "/repo",
        source: "proxy_headers",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:01:00.000Z",
      }),
    ]);
  });

  it("initializes SQLite pragmas, schema, indexes, and version", () => {
    const { store, path } = createStore();
    expect(store.getState()).toMatchObject({ path, rowCount: 0, contextCount: 0 });

    const db = new Database(path, { readonly: true });
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    const objects = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>;
    expect(objects.map((item) => item.name)).toEqual(expect.arrayContaining([
      "call_contexts", "call_records", "idx_call_records_completed_at", "idx_call_records_context_id",
      "idx_call_records_model", "idx_call_records_provider", "idx_call_records_account_id", "idx_call_records_protocol",
    ]));
    db.close();
  });

  it("upserts contexts without null overwrites and ignores duplicate request IDs", () => {
    const { store } = createStore();
    const first = record();
    expect(store.insert(first)).toBe(true);
    expect(store.insert({
      ...first,
      id: "different-id",
      context: {
        sessionId: "duplicate-session",
        taskId: null,
        cwd: null,
        source: "responses",
        contextKey: "duplicate-context",
      },
    })).toBe(false);
    expect(store.getState().contextCount).toBe(1);
    expect(store.insert(record({
      requestId: "request-2",
      completedAt: "2026-07-12T00:00:00.000Z",
      context: { ...first.context, taskId: null, cwd: null },
    }))).toBe(true);

    const contexts = store.listContexts({});
    expect(contexts.total).toBe(1);
    expect(contexts.contexts[0]).toMatchObject({
      sessionId: "session-a", taskId: "task-a", cwd: "/repo/a", callCount: 2,
      updatedAt: "2026-07-12T00:00:00.000Z",
    });
  });
});

describe("CallRecordStore queries", () => {
  it("filters every allowlisted dimension and emits previews instead of bodies", () => {
    const { store } = createStore();
    seed(store);

    expect(store.list({ from: "2026-07-13T00:00:00.000Z", to: "2026-07-14T23:59:59.999Z" }).total).toBe(2);
    expect(store.list({ sessionId: "session-b" }).total).toBe(2);
    expect(store.list({ taskId: "task-b" }).total).toBe(2);
    expect(store.list({ cwd: "/repo/c" }).total).toBe(1);
    expect(store.list({ model: "gpt-5.5" }).records.map((item) => item.requestId)).toEqual(["r2"]);
    expect(store.list({ provider: "anthropic" }).total).toBe(1);
    expect(store.list({ accountId: "account-a" }).total).toBe(3);
    expect(store.list({ protocol: "gemini" }).total).toBe(1);
    expect(store.list({ stream: true }).total).toBe(2);
    expect(store.list({ contextId: store.listContexts({ sessionId: "session-a" }).contexts[0].id }).total).toBe(2);

    const item = store.list({ limit: 1 }).records[0];
    expect(item.requestPreview.length).toBeGreaterThan(0);
    expect(item.responsePreview.length).toBeGreaterThan(0);
    expect(item).not.toHaveProperty("requestJson");
    expect(item).not.toHaveProperty("responseJson");
    expect(store.get(item.id)).toMatchObject({ requestId: item.requestId });
    expect(store.get("missing")).toBeNull();
  });

  it("supports allowlisted sorting and pagination", () => {
    const { store } = createStore();
    seed(store);

    expect(store.list({ sort: "input_tokens", order: "asc", limit: 2, offset: 1 }).records.map((item) => item.requestId)).toEqual(["r2", "r3"]);
    expect(store.list({ sort: "latency_ms", order: "desc", limit: 1 }).records[0].requestId).toBe("r3");
  });

  it("aggregates grouped contexts with filtering and sorting", () => {
    const { store } = createStore();
    seed(store);

    const page = store.listContexts({ sort: "input_tokens", order: "desc" });
    expect(page.total).toBe(3);
    expect(page.contexts[0]).toMatchObject({ cwd: "/repo/b", callCount: 2, inputTokens: 700 });
    expect(store.listContexts({ provider: "anthropic" }).contexts).toEqual([
      expect.objectContaining({ sessionId: "session-b", callCount: 1, inputTokens: 300 }),
    ]);
  });

  it("reports state, clears, and removes expired calls plus orphan contexts", () => {
    const { store, path } = createStore();
    seed(store);
    expect(store.getState()).toMatchObject({ rowCount: 6, contextCount: 3 });
    expect(statSync(path).size).toBeGreaterThan(0);

    expect(store.cleanup(30, new Date("2026-08-13T00:00:00.000Z"))).toBe(3);
    expect(store.getState()).toMatchObject({ rowCount: 3, contextCount: 2 });
    expect(store.cleanup(null)).toBe(0);
    store.clear();
    expect(store.getState()).toMatchObject({ rowCount: 0, contextCount: 0 });
  });

  it("removes every expired row in one cleanup run instead of one fixed batch", () => {
    const { store } = createStore();
    for (let index = 0; index < 1005; index++) {
      expect(store.insert(record({
        requestId: `expired-${index}`,
        completedAt: "2026-07-01T00:00:00.000Z",
      }))).toBe(true);
    }

    expect(store.cleanup(7, new Date("2026-07-11T00:00:00.000Z"))).toBe(1005);
    expect(store.getState().rowCount).toBe(0);
  }, 15_000);

  it("enforces a maximum row count while retaining the newest records", () => {
    const { store } = createStore();
    for (let index = 0; index < 4; index++) {
      expect(store.insert(record({
        requestId: `bounded-${index}`,
        completedAt: `2026-07-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
      }))).toBe(true);
    }

    expect(store.cleanup(null, new Date("2026-07-20T00:00:00.000Z"), 2)).toBe(2);
    expect(store.list({ sort: "completed_at", order: "asc" }).records.map((item) => item.requestId)).toEqual([
      "bounded-2",
      "bounded-3",
    ]);
  });
});

describe("CallRecordStore search", () => {
  it("searches request and response content through FTS5 when available", () => {
    const { store } = createStore();
    seed(store);
    if (store.getState().searchMode === "fts5") {
      expect(store.list({ search: "needle" }).records.map((item) => item.requestId).sort()).toEqual(["r2", "r3"]);
    }
  });

  it("finds CJK substrings when FTS5 tokenization cannot", () => {
    const { store } = createStore();
    expect(store.insert(record({
      requestId: "cjk",
      requestJson: JSON.stringify({ prompt: "分析日常使用情况" }),
    }))).toBe(true);

    expect(store.list({ search: "使用" }).records.map((item) => item.requestId)).toEqual(["cjk"]);
  });

  it("falls back to escaped parameterized LIKE search", () => {
    const { store } = createStore({ forceSearchMode: "like" });
    seed(store);
    expect(store.getState().searchMode).toBe("like");
    expect(store.list({ search: "needle" }).total).toBe(2);
    expect(store.list({ search: "%' OR 1=1 --" }).total).toBe(0);
  });
});
