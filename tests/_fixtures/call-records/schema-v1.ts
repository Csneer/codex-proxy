import Database from "better-sqlite3";

export function createSchemaV1Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS call_contexts (
      id TEXT PRIMARY KEY,
      context_key TEXT NOT NULL UNIQUE,
      session_id TEXT,
      task_id TEXT,
      cwd TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (session_id IS NOT NULL OR task_id IS NOT NULL OR cwd IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS call_records (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      context_id TEXT REFERENCES call_contexts(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      route TEXT NOT NULL,
      protocol TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT,
      model TEXT NOT NULL,
      upstream_model TEXT,
      stream INTEGER NOT NULL,
      response_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      image_input_tokens INTEGER NOT NULL,
      image_output_tokens INTEGER NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      request_bytes INTEGER NOT NULL,
      response_bytes INTEGER NOT NULL,
      request_truncated INTEGER NOT NULL,
      response_truncated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_records_completed_at ON call_records(completed_at);
    CREATE INDEX IF NOT EXISTS idx_call_records_context_id ON call_records(context_id);
    CREATE INDEX IF NOT EXISTS idx_call_records_model ON call_records(model);
    CREATE INDEX IF NOT EXISTS idx_call_records_provider ON call_records(provider);
    CREATE INDEX IF NOT EXISTS idx_call_records_account_id ON call_records(account_id);
    CREATE INDEX IF NOT EXISTS idx_call_records_protocol ON call_records(protocol);
    CREATE INDEX IF NOT EXISTS idx_call_records_completed_model ON call_records(completed_at, model);
    PRAGMA user_version = 1;
  `);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS call_records_fts USING fts5(
        request_json, response_json, content='call_records', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS call_records_fts_insert AFTER INSERT ON call_records BEGIN
        INSERT INTO call_records_fts(rowid, request_json, response_json)
        VALUES (new.rowid, new.request_json, new.response_json);
      END;
      CREATE TRIGGER IF NOT EXISTS call_records_fts_delete AFTER DELETE ON call_records BEGIN
        INSERT INTO call_records_fts(call_records_fts, rowid, request_json, response_json)
        VALUES ('delete', old.rowid, old.request_json, old.response_json);
      END;
      CREATE TRIGGER IF NOT EXISTS call_records_fts_update AFTER UPDATE ON call_records BEGIN
        INSERT INTO call_records_fts(call_records_fts, rowid, request_json, response_json)
        VALUES ('delete', old.rowid, old.request_json, old.response_json);
        INSERT INTO call_records_fts(rowid, request_json, response_json)
        VALUES (new.rowid, new.request_json, new.response_json);
      END;
      INSERT INTO call_records_fts(call_records_fts) VALUES ('rebuild');
    `);
  } catch {
    // Production v1 falls back to LIKE search when SQLite does not provide FTS5.
  }
  db.prepare("INSERT INTO call_contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ctx-1",
    "hash-1",
    "session-1",
    "task-1",
    "/repo",
    "proxy_headers",
    "2026-07-18T00:00:00.000Z",
    "2026-07-18T00:01:00.000Z",
  );
  db.prepare(`INSERT INTO call_records VALUES (
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
  )`).run(
    "call-1",
    "request-1",
    "ctx-1",
    "2026-07-18T00:00:00.000Z",
    "2026-07-18T00:01:00.000Z",
    60_000,
    "/v1/responses",
    "responses",
    "codex",
    "account-1",
    "gpt-5.6-sol",
    "gpt-5.6-sol",
    1,
    "resp-1",
    100,
    20,
    80,
    5,
    0,
    0,
    JSON.stringify({ input: [{ role: "user", content: "legacy question" }] }),
    JSON.stringify([{ event: "response.completed", data: { output_text: "legacy answer" } }]),
    80,
    96,
    0,
    0,
  );
  db.close();
}
