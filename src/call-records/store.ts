import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CallContextPage,
  CallContextQuery,
  CallContextSummary,
  CallProtocol,
  CallRecordDetail,
  CallRecordPage,
  CallRecordQuery,
  CallRecordStoreState,
  CallRecordSummary,
  CompletedCallRecord,
} from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PREVIEW_LENGTH = 240;
const CLEANUP_BATCH_SIZE = 1000;
const require = createRequire(import.meta.url);

interface SqliteRunResult { changes: number | bigint }
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): SqliteRunResult;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteDatabaseConstructor = new (path: string) => SqliteDatabase;

interface StoreOptions {
  path: string;
  forceSearchMode?: "like";
}

interface ContextRow {
  id: string;
  session_id: string | null;
  task_id: string | null;
  cwd: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

interface RecordRow {
  id: string;
  request_id: string;
  context_id: string | null;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  route: string;
  protocol: CallProtocol;
  provider: string;
  account_id: string | null;
  model: string;
  upstream_model: string | null;
  stream: number;
  response_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  image_input_tokens: number;
  image_output_tokens: number;
  request_json: string;
  response_json: string;
  request_bytes: number;
  response_bytes: number;
  request_truncated: number;
  response_truncated: number;
  session_id: string | null;
  task_id: string | null;
  cwd: string | null;
  context_source: string | null;
}

interface CountRow { total: number }

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toFtsQuery(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}

function containsCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function preview(json: string): string {
  return json.length > PREVIEW_LENGTH ? `${json.slice(0, PREVIEW_LENGTH)}…` : json;
}

function mapRecord(row: RecordRow): CallRecordSummary {
  return {
    id: row.id,
    requestId: row.request_id,
    contextId: row.context_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    cwd: row.cwd,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    latencyMs: row.latency_ms,
    route: row.route,
    protocol: row.protocol,
    provider: row.provider,
    accountId: row.account_id,
    model: row.model,
    upstreamModel: row.upstream_model,
    stream: row.stream === 1,
    responseId: row.response_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    reasoningTokens: row.reasoning_tokens,
    imageInputTokens: row.image_input_tokens,
    imageOutputTokens: row.image_output_tokens,
    requestBytes: row.request_bytes,
    responseBytes: row.response_bytes,
    requestTruncated: row.request_truncated === 1,
    responseTruncated: row.response_truncated === 1,
    requestPreview: preview(row.request_json),
    responsePreview: preview(row.response_json),
  };
}

export class CallRecordStore {
  private readonly db: SqliteDatabase;
  private readonly path: string;
  private readonly searchMode: "fts5" | "like";

  constructor(options: StoreOptions) {
    this.path = options.path;
    const directory = dirname(options.path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    this.db = openDatabase(options.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initializeSchema();
    this.searchMode = options.forceSearchMode === "like" ? "like" : this.initializeFts();
  }

  insert(record: CompletedCallRecord): boolean {
    return this.transaction(() => {
      const duplicate = this.db.prepare("SELECT 1 AS present FROM call_records WHERE request_id = ?").get(record.requestId);
      if (duplicate) return false;
      let contextId: string | null = null;
      if (record.context.contextKey) {
        contextId = this.upsertContext(record);
      }
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO call_records (
          id, request_id, context_id, started_at, completed_at, latency_ms,
          route, protocol, provider, account_id, model, upstream_model, stream,
          response_id, input_tokens, output_tokens, cached_tokens, reasoning_tokens,
          image_input_tokens, image_output_tokens, request_json, response_json,
          request_bytes, response_bytes, request_truncated, response_truncated
        ) VALUES (
          @id, @requestId, @contextId, @startedAt, @completedAt, @latencyMs,
          @route, @protocol, @provider, @accountId, @model, @upstreamModel, @stream,
          @responseId, @inputTokens, @outputTokens, @cachedTokens, @reasoningTokens,
          @imageInputTokens, @imageOutputTokens, @requestJson, @responseJson,
          @requestBytes, @responseBytes, @requestTruncated, @responseTruncated
        )
      `).run({
        id: record.id,
        requestId: record.requestId,
        contextId,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        latencyMs: record.latencyMs,
        route: record.route,
        protocol: record.protocol,
        provider: record.provider,
        accountId: record.accountId,
        model: record.model,
        upstreamModel: record.upstreamModel,
        stream: record.stream ? 1 : 0,
        responseId: record.responseId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cachedTokens: record.cachedTokens,
        reasoningTokens: record.reasoningTokens,
        imageInputTokens: record.imageInputTokens,
        imageOutputTokens: record.imageOutputTokens,
        requestJson: record.requestJson,
        responseJson: record.responseJson,
        requestBytes: record.requestBytes,
        responseBytes: record.responseBytes,
        requestTruncated: record.requestTruncated ? 1 : 0,
        responseTruncated: record.responseTruncated ? 1 : 0,
      });
      return Number(result.changes) === 1;
    });
  }

  list(query: CallRecordQuery = {}): CallRecordPage {
    const { where, params } = this.buildFilters(query);
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM call_records r
      LEFT JOIN call_contexts c ON c.id = r.context_id
      ${where}
    `).get(params) as CountRow).total;
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);
    const sortColumns = {
      completed_at: "r.completed_at",
      latency_ms: "r.latency_ms",
      input_tokens: "r.input_tokens",
      output_tokens: "r.output_tokens",
    } as const;
    const sort = sortColumns[query.sort ?? "completed_at"] ?? sortColumns.completed_at;
    const order = query.order === "asc" ? "ASC" : "DESC";
    const rows = this.db.prepare(`
      SELECT r.*, c.session_id, c.task_id, c.cwd, c.source AS context_source
      FROM call_records r
      LEFT JOIN call_contexts c ON c.id = r.context_id
      ${where}
      ORDER BY ${sort} ${order}, r.id ${order}
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset }) as RecordRow[];
    return { records: rows.map(mapRecord), total, limit, offset };
  }

  get(id: string): CallRecordDetail | null {
    const row = this.db.prepare(`
      SELECT r.*, c.session_id, c.task_id, c.cwd, c.source AS context_source
      FROM call_records r
      LEFT JOIN call_contexts c ON c.id = r.context_id
      WHERE r.id = ?
    `).get(id) as RecordRow | undefined;
    if (!row) return null;
    return {
      ...mapRecord(row),
      contextSource: row.context_source,
      requestJson: row.request_json,
      responseJson: row.response_json,
    };
  }

  listContexts(query: CallContextQuery = {}): CallContextPage {
    const { where, params } = this.buildFilters(query);
    const contextWhere = where ? `${where} AND r.context_id IS NOT NULL` : "WHERE r.context_id IS NOT NULL";
    const grouped = `
      FROM call_records r
      JOIN call_contexts c ON c.id = r.context_id
      ${contextWhere}
      GROUP BY c.id
    `;
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM (SELECT c.id ${grouped})`).get(params) as CountRow).total;
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);
    const sortColumns = {
      updated_at: "c.updated_at",
      call_count: "call_count",
      input_tokens: "input_tokens",
      output_tokens: "output_tokens",
    } as const;
    const sort = sortColumns[query.sort ?? "updated_at"] ?? sortColumns.updated_at;
    const order = query.order === "asc" ? "ASC" : "DESC";
    const rows = this.db.prepare(`
      SELECT
        c.id, c.session_id, c.task_id, c.cwd, c.source, c.created_at, c.updated_at,
        MIN(r.completed_at) AS first_completed_at,
        MAX(r.completed_at) AS last_completed_at,
        COUNT(*) AS call_count,
        SUM(r.input_tokens) AS input_tokens,
        SUM(r.output_tokens) AS output_tokens,
        SUM(r.cached_tokens) AS cached_tokens,
        SUM(r.reasoning_tokens) AS reasoning_tokens
      ${grouped}
      ORDER BY ${sort} ${order}, c.id ${order}
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset }) as Array<ContextRow & {
      first_completed_at: string;
      last_completed_at: string;
      call_count: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      reasoning_tokens: number;
    }>;
    const contexts: CallContextSummary[] = rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      cwd: row.cwd,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      firstCompletedAt: row.first_completed_at,
      lastCompletedAt: row.last_completed_at,
      callCount: row.call_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      reasoningTokens: row.reasoning_tokens,
    }));
    return { contexts, total, limit, offset };
  }

  getState(): CallRecordStoreState {
    const rowCount = (this.db.prepare("SELECT COUNT(*) AS total FROM call_records").get() as CountRow).total;
    const contextCount = (this.db.prepare("SELECT COUNT(*) AS total FROM call_contexts").get() as CountRow).total;
    const databaseBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    return { path: this.path, rowCount, contextCount, databaseBytes, searchMode: this.searchMode };
  }

  /** Read-only aggregate helper for dashboard analytics. */
  queryAnalytics<T = unknown>(sql: string, params: Record<string, unknown> = {}): T[] {
    return this.db.prepare(sql).all(params) as T[];
  }

  cleanup(retentionDays: number | null, now = new Date()): number {
    if (retentionDays === null) return 0;
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    return this.transaction(() => {
      const result = this.db.prepare(`
        DELETE FROM call_records
        WHERE rowid IN (
          SELECT rowid FROM call_records
          WHERE completed_at < ?
          ORDER BY completed_at ASC
          LIMIT ?
        )
      `).run(cutoff, CLEANUP_BATCH_SIZE);
      this.db.prepare("DELETE FROM call_contexts WHERE NOT EXISTS (SELECT 1 FROM call_records WHERE context_id = call_contexts.id)").run();
      return Number(result.changes);
    });
  }

  clear(): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM call_records").run();
      this.db.prepare("DELETE FROM call_contexts").run();
    });
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
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
  }

  private initializeFts(): "fts5" | "like" {
    try {
      this.db.exec(`
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
      return "fts5";
    } catch {
      return "like";
    }
  }

  private upsertContext(record: CompletedCallRecord): string {
    const context = record.context;
    const existing = this.db.prepare("SELECT id FROM call_contexts WHERE context_key = ?").get(context.contextKey) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO call_contexts (
        id, context_key, session_id, task_id, cwd, source, created_at, updated_at
      ) VALUES (
        @id, @contextKey, @sessionId, @taskId, @cwd, @source, @completedAt, @completedAt
      )
      ON CONFLICT(context_key) DO UPDATE SET
        session_id = COALESCE(call_contexts.session_id, excluded.session_id),
        task_id = COALESCE(call_contexts.task_id, excluded.task_id),
        cwd = COALESCE(call_contexts.cwd, excluded.cwd),
        updated_at = CASE WHEN excluded.updated_at > call_contexts.updated_at THEN excluded.updated_at ELSE call_contexts.updated_at END
    `).run({
      id,
      contextKey: context.contextKey,
      sessionId: context.sessionId,
      taskId: context.taskId,
      cwd: context.cwd,
      source: context.source,
      completedAt: record.completedAt,
    });
    return id;
  }

  private buildFilters(query: CallRecordQuery | CallContextQuery): { where: string; params: Record<string, unknown> } {
    const filters: string[] = [];
    const params: Record<string, unknown> = {};
    const exact = [
      ["contextId", "r.context_id"],
      ["sessionId", "c.session_id"],
      ["taskId", "c.task_id"],
      ["cwd", "c.cwd"],
      ["model", "r.model"],
      ["provider", "r.provider"],
      ["accountId", "r.account_id"],
      ["protocol", "r.protocol"],
    ] as const;
    for (const [key, column] of exact) {
      const value = query[key as keyof typeof query];
      if (typeof value === "string" && value.length > 0) {
        filters.push(`${column} = @${key}`);
        params[key] = value;
      }
    }
    if (query.from) {
      filters.push("r.completed_at >= @from");
      params.from = query.from;
    }
    if (query.to) {
      filters.push("r.completed_at <= @to");
      params.to = query.to;
    }
    if (typeof query.stream === "boolean") {
      filters.push("r.stream = @stream");
      params.stream = query.stream ? 1 : 0;
    }
    const search = query.search?.trim();
    if (search) {
      if (this.searchMode === "fts5" && !containsCjk(search)) {
        filters.push("r.rowid IN (SELECT rowid FROM call_records_fts WHERE call_records_fts MATCH @search)");
        params.search = toFtsQuery(search);
      } else {
        filters.push("(r.request_json LIKE @search ESCAPE '\\' OR r.response_json LIKE @search ESCAPE '\\')");
        params.search = `%${escapeLike(search)}%`;
      }
    }
    return { where: filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "", params };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }
}

function openDatabase(path: string): SqliteDatabase {
  try {
    const loaded = require("node:sqlite") as { DatabaseSync?: SqliteDatabaseConstructor };
    if (typeof loaded.DatabaseSync === "function") return new loaded.DatabaseSync(path);
  } catch {
    // Fall through to the installed compatibility dependency.
  }
  const loaded = require("better-sqlite3") as unknown;
  if (typeof loaded !== "function") throw new Error("No compatible SQLite database constructor found");
  return new (loaded as SqliteDatabaseConstructor)(path);
}
