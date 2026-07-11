import { Hono, type Context } from "hono";
import { z } from "zod";
import { getCallRecordStore } from "../../call-records/service.js";
import type { CallContextQuery, CallRecordQuery } from "../../call-records/types.js";
import { getConfig } from "../../config.js";

const OptionalText = z.string().trim().min(1).max(2048).optional();
const OptionalDateTime = z.string().datetime({ offset: true }).optional();
const OptionalBoolean = z.enum(["true", "false"]).transform((value) => value === "true").optional();
const OptionalLimit = z.preprocess(
  (value) => value === undefined ? undefined : Number(value),
  z.number().int().min(1).max(200).optional(),
);
const OptionalOffset = z.preprocess(
  (value) => value === undefined ? undefined : Number(value),
  z.number().int().min(0).optional(),
);

const BaseQuerySchema = z.object({
  from: OptionalDateTime,
  to: OptionalDateTime,
  session_id: OptionalText,
  task_id: OptionalText,
  cwd: OptionalText,
  model: OptionalText,
  provider: OptionalText,
  account_id: OptionalText,
  protocol: z.enum(["openai", "anthropic", "gemini", "responses", "official-agent"]).optional(),
  stream: OptionalBoolean,
  search: OptionalText,
  order: z.enum(["asc", "desc"]).optional(),
  limit: OptionalLimit,
  offset: OptionalOffset,
});

const ListQuerySchema = BaseQuerySchema.extend({
  context_id: OptionalText,
  sort: z.enum(["completed_at", "latency_ms", "input_tokens", "output_tokens"]).optional(),
});

const ContextQuerySchema = BaseQuerySchema.extend({
  sort: z.enum(["updated_at", "call_count", "input_tokens", "output_tokens"]).optional(),
});

function rawQuery(c: Context): Record<string, string | undefined> {
  return {
    from: c.req.query("from"),
    to: c.req.query("to"),
    context_id: c.req.query("context_id"),
    session_id: c.req.query("session_id"),
    task_id: c.req.query("task_id"),
    cwd: c.req.query("cwd"),
    model: c.req.query("model"),
    provider: c.req.query("provider"),
    account_id: c.req.query("account_id"),
    protocol: c.req.query("protocol"),
    stream: c.req.query("stream"),
    search: c.req.query("search"),
    sort: c.req.query("sort"),
    order: c.req.query("order"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  };
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function toRecordQuery(data: z.infer<typeof ListQuerySchema>): CallRecordQuery {
  return compact({
    from: data.from,
    to: data.to,
    contextId: data.context_id,
    sessionId: data.session_id,
    taskId: data.task_id,
    cwd: data.cwd,
    model: data.model,
    provider: data.provider,
    accountId: data.account_id,
    protocol: data.protocol,
    stream: data.stream,
    search: data.search,
    sort: data.sort,
    order: data.order,
    limit: data.limit,
    offset: data.offset,
  });
}

function toContextQuery(data: z.infer<typeof ContextQuerySchema>): CallContextQuery {
  return compact({
    from: data.from,
    to: data.to,
    sessionId: data.session_id,
    taskId: data.task_id,
    cwd: data.cwd,
    model: data.model,
    provider: data.provider,
    accountId: data.account_id,
    protocol: data.protocol,
    stream: data.stream,
    search: data.search,
    sort: data.sort,
    order: data.order,
    limit: data.limit,
    offset: data.offset,
  });
}

export function createCallRecordRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/call-records", (c) => {
    const parsed = ListQuerySchema.safeParse(rawQuery(c));
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }
    const store = getCallRecordStore();
    if (!store) {
      c.status(503);
      return c.json({ error: "call_record_store_unavailable" });
    }
    return c.json(store.list(toRecordQuery(parsed.data)));
  });

  app.get("/admin/call-contexts", (c) => {
    const parsed = ContextQuerySchema.safeParse(rawQuery(c));
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }
    const store = getCallRecordStore();
    if (!store) {
      c.status(503);
      return c.json({ error: "call_record_store_unavailable" });
    }
    return c.json(store.listContexts(toContextQuery(parsed.data)));
  });

  app.get("/admin/call-records/state", (c) => {
    const store = getCallRecordStore();
    if (!store) {
      c.status(503);
      return c.json({ error: "call_record_store_unavailable" });
    }
    const config = getConfig().call_records;
    return c.json({
      enabled: config.enabled,
      retentionDays: config.retention_days,
      maxBodyBytes: config.max_body_bytes,
      ...store.getState(),
    });
  });

  app.post("/admin/call-records/clear", (c) => {
    const store = getCallRecordStore();
    if (!store) {
      c.status(503);
      return c.json({ error: "call_record_store_unavailable" });
    }
    store.clear();
    return c.json({ ok: true });
  });

  app.get("/admin/call-records/:id", (c) => {
    const store = getCallRecordStore();
    if (!store) {
      c.status(503);
      return c.json({ error: "call_record_store_unavailable" });
    }
    const record = store.get(c.req.param("id"));
    if (!record) {
      c.status(404);
      return c.json({ error: "not_found" });
    }
    return c.json(record);
  });

  return app;
}
