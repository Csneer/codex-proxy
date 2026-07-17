# Call Observability Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the secure, versioned semantic/raw storage foundation and reliable outcome counters needed by the approved call-observability product without changing successful proxy responses.

**Architecture:** Keep `call-records.sqlite` as the permanent semantic database, add `call-records-raw.sqlite` for bounded gzip evidence, and project protocol bodies through a versioned pure-function boundary before persistence. One request-owned `CallOutcomeTracker` counts actual upstream model dispatches and exactly one terminal outcome. A shared CSRF guard protects browser-driven `/admin/*` mutations before new destructive routes are exposed.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Node `zlib`/`crypto`, Vitest, Preact shared hooks.

**Prerequisites:** Execute in a dedicated worktree created with `superpowers:using-git-worktrees`. Start from commit `7c8edd2` or a descendant containing the approved `DESIGN.md` and feature specification. Preserve the existing successful-call semantics and do not run compact-file cutover in this plan.

---

## File structure

- Create `src/middleware/admin-mutation-guard.ts`: exact-origin and CSRF verification for browser `/admin/*` mutations.
- Create `src/auth/dashboard-csrf.ts`: process/session-bound, expiring token issue/verify store.
- Create `shared/http/admin-fetch.ts`: browser helper that fetches and attaches the CSRF token.
- Create `src/call-records/semantic-projector.ts`: protocol-neutral projection dispatcher and bounds.
- Create `src/call-records/semantic-request.ts`: current-turn extraction for supported request protocols.
- Create `src/call-records/semantic-response.ts`: final text/tool projection for non-streaming and captured streaming responses.
- Create `src/call-records/raw-store.ts`: gzip raw evidence insert/get/cleanup database.
- Create `src/call-records/outcome-tracker.ts`: request-level attempt and terminal outcome state machine.
- Create `src/call-records/migration.ts`: resumable v1-to-v2 additive backfill; no file swap.
- Modify `src/call-records/types.ts`: v2 domain, projection, raw state, and outcome types.
- Modify `src/call-records/store.ts`: additive v2 schema, semantic FTS, outcome buckets, dual reads, and aggregates.
- Modify `src/call-records/recorder.ts`: project once, commit semantic first, raw second.
- Modify `src/call-records/capture.ts`: expose attempt/terminal hooks on the pending record.
- Modify `src/call-records/service.ts`: initialize both stores and bounded maintenance timers.
- Modify `src/config-schema.ts`, `src/config-loader.ts`, `config/default.yaml`, `src/routes/admin/settings.ts`: approved configuration and legacy aliases.
- Modify the real model-dispatch paths listed in Task 7; do not count high-level retry decisions.

### Task 1: Lock legacy behavior and schema-v1 migration input

**Files:**
- Create: `tests/_fixtures/call-records/schema-v1.ts`
- Modify: `tests/unit/call-records/store.test.ts`
- Modify: `tests/integration/call-records-proxy.test.ts`

- [ ] **Step 1: Add a reusable legacy database fixture**

```ts
// tests/_fixtures/call-records/schema-v1.ts
import Database from "better-sqlite3";

export function createSchemaV1Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE call_contexts (
      id TEXT PRIMARY KEY, context_key TEXT NOT NULL UNIQUE,
      session_id TEXT, task_id TEXT, cwd TEXT, source TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE call_records (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, context_id TEXT,
      started_at TEXT NOT NULL, completed_at TEXT NOT NULL, latency_ms INTEGER NOT NULL,
      route TEXT NOT NULL, protocol TEXT NOT NULL, provider TEXT NOT NULL,
      account_id TEXT, model TEXT NOT NULL, upstream_model TEXT, stream INTEGER NOT NULL,
      response_id TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
      image_input_tokens INTEGER NOT NULL, image_output_tokens INTEGER NOT NULL,
      request_json TEXT NOT NULL, response_json TEXT NOT NULL,
      request_bytes INTEGER NOT NULL, response_bytes INTEGER NOT NULL,
      request_truncated INTEGER NOT NULL, response_truncated INTEGER NOT NULL
    );
  `);
  db.prepare(`INSERT INTO call_contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "ctx-1", "hash-1", "session-1", "task-1", "/repo", "proxy_headers",
    "2026-07-18T00:00:00.000Z", "2026-07-18T00:01:00.000Z",
  );
  db.prepare(`INSERT INTO call_records VALUES (
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
  )`).run(
    "call-1", "request-1", "ctx-1", "2026-07-18T00:00:00.000Z",
    "2026-07-18T00:01:00.000Z", 60_000, "/v1/responses", "responses", "codex",
    "account-1", "gpt-5.6-sol", "gpt-5.6-sol", 1, "resp-1",
    100, 20, 80, 5, 0, 0,
    JSON.stringify({ input: [{ role: "user", content: "legacy question" }] }),
    JSON.stringify([{ event: "response.completed", data: { output_text: "legacy answer" } }]),
    80, 96, 0, 0,
  );
  db.close();
}
```

- [ ] **Step 2: Add passing characterization tests for stable legacy behavior**

```ts
// tests/unit/call-records/store.test.ts
it("opens a schema-v1 database without losing stable metadata", () => {
  createSchemaV1Database(path);
  const store = new CallRecordStore({ path });
  expect(store.get("call-1")).toMatchObject({ requestId: "request-1", inputTokens: 100 });
});

// tests/integration/call-records-proxy.test.ts
it("writes exactly one current success and no row for a terminal failure", async () => {
  await sendSuccessfulCall(app);
  await sendTerminalFailure(app);
  expect(store.list().total).toBe(1);
});
```

- [ ] **Step 3: Run the characterization tests and verify they pass**

Run:

```bash
npx vitest run tests/unit/call-records/store.test.ts tests/integration/call-records-proxy.test.ts
```

Expected: PASS. This proves the fixture represents the current schema and locks the successful-call/no-failed-row contract before v2 work begins.

- [ ] **Step 4: Preserve the fixtures without adding production behavior yet**

Add only the fixture export and characterization tests in this task. Do not add v2 APIs yet.

- [ ] **Step 5: Commit the green characterization tests and fixture**

```bash
git add tests/_fixtures/call-records/schema-v1.ts tests/unit/call-records/store.test.ts tests/integration/call-records-proxy.test.ts
git commit -m "Lock the evidence required for a lossless call-record upgrade" \
  -m "Constraint: Preserve schema-v1 metadata and successful-call semantics before storage changes." \
  -m "Confidence: high" -m "Scope-risk: narrow" \
  -m "Tested: Schema-v1 store and successful-call/no-failed-row characterization tests pass." \
  -m "Not-tested: V2 migration behavior is introduced test-first in Task 5."
```

### Task 2: Add the shared admin mutation and CSRF boundary

**Files:**
- Create: `src/auth/dashboard-csrf.ts`
- Create: `src/middleware/admin-mutation-guard.ts`
- Create: `shared/http/admin-fetch.ts`
- Create: `tests/unit/auth/dashboard-csrf.test.ts`
- Create: `tests/unit/middleware/admin-mutation-guard.test.ts`
- Create: `shared/http/admin-fetch.test.ts`
- Modify: `src/auth/dashboard-session.ts`
- Modify: `src/routes/dashboard-login.ts`
- Modify: `src/index.ts`
- Modify: all shared/Web files with `/admin/*` mutations found by `rg 'method:.*(POST|PUT|PATCH|DELETE)' shared web/src`

- [ ] **Step 1: Write failing token and guard tests**

```ts
it("binds a token to one dashboard principal and expiry", () => {
  const tokens = createDashboardCsrfStore({ now: () => 1_000, ttlMs: 60_000 });
  const issued = tokens.issue("session:s1");
  expect(tokens.verify("session:s1", issued.token)).toBe(true);
  expect(tokens.verify("session:s2", issued.token)).toBe(false);
  tokens.setNowForTest(61_001);
  expect(tokens.verify("session:s1", issued.token)).toBe(false);
});

it("rejects a cookie-backed admin mutation without exact origin and token", async () => {
  const res = await app.request("http://proxy.local/admin/settings", {
    method: "POST",
    headers: { Cookie: "_codex_session=s1", Origin: "https://evil.example" },
  });
  expect(res.status).toBe(403);
});

it("allows explicit bearer auth without a dashboard cookie", async () => {
  const res = await app.request("http://proxy.local/admin/settings", {
    method: "POST", headers: { Authorization: "Bearer test-key" },
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npx vitest run tests/unit/auth/dashboard-csrf.test.ts tests/unit/middleware/admin-mutation-guard.test.ts shared/http/admin-fetch.test.ts
```

Expected: FAIL on missing modules and missing `GET /admin/csrf` behavior.

- [ ] **Step 3: Implement the bounded token store and guard**

```ts
// src/auth/dashboard-csrf.ts
import { randomBytes, timingSafeEqual } from "node:crypto";

export function createDashboardCsrfStore(options: { now?: () => number; ttlMs?: number } = {}) {
  let now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const tokens = new Map<string, { hash: Buffer; expiresAt: number }>();
  return {
    issue(principal: string) {
      const token = randomBytes(32).toString("base64url");
      tokens.set(principal, { hash: Buffer.from(token), expiresAt: now() + ttlMs });
      return { token, expiresAt: now() + ttlMs };
    },
    verify(principal: string, token: string) {
      const item = tokens.get(principal);
      const candidate = Buffer.from(token);
      if (!item || now() > item.expiresAt || candidate.length !== item.hash.length) return false;
      return timingSafeEqual(candidate, item.hash);
    },
    revoke(principal: string) { tokens.delete(principal); },
    setNowForTest(next: number) { now = () => next; },
  };
}
```

```ts
// src/middleware/admin-mutation-guard.ts
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
export async function adminMutationGuard(c: Context, next: Next) {
  if (!c.req.path.startsWith("/admin/") || SAFE.has(c.req.method)) return next();
  const bearer = c.req.header("authorization")?.startsWith("Bearer ") === true;
  const cookie = parseSessionCookie(c.req.header("cookie"));
  if (bearer && !cookie) return next();
  const origin = c.req.header("origin");
  if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: "csrf_origin" }, 403);
  const principal = cookie ? `session:${cookie}` : `local:${getRealClientIp(c, getConfig().server.trust_proxy)}`;
  if (!csrfStore.verify(principal, c.req.header("x-codex-proxy-csrf") ?? "")) {
    return c.json({ error: "csrf_token" }, 403);
  }
  return next();
}
```

Mount `adminMutationGuard` immediately after `dashboardAuth` in `src/index.ts`. Add authenticated `GET /admin/csrf` to `createDashboardAuthRoutes()`. Revoke the session token during logout.

- [ ] **Step 4: Implement one cached client helper and migrate admin mutations**

```ts
// shared/http/admin-fetch.ts
let cached: { token: string; expiresAt: number } | null = null;
export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return fetch(input, init);
  if (!cached || Date.now() >= cached.expiresAt - 5_000) {
    const response = await fetch("/admin/csrf");
    if (!response.ok) return response;
    cached = await response.json() as { token: string; expiresAt: number };
  }
  const headers = new Headers(init.headers);
  headers.set("X-Codex-Proxy-CSRF", cached.token);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 403) cached = null;
  return response;
}
export function clearAdminCsrfCache(): void { cached = null; }
```

Replace only `/admin/*` state-changing fetch calls with `adminFetch`; leave `/v1`, `/auth`, and `/api` calls unchanged. Add `clearAdminCsrfCache()` to login/logout transitions.

- [ ] **Step 5: Verify security and existing mutation behavior**

Run:

```bash
npx vitest run tests/unit/auth/dashboard-csrf.test.ts tests/unit/middleware/admin-mutation-guard.test.ts tests/unit/middleware/dashboard-auth.test.ts tests/unit/routes/dashboard-login.test.ts shared/http/admin-fetch.test.ts tests/integration/error-logs-dashboard-auth.test.ts
npm run test:web
```

Expected: PASS; hostile origin/tokenless cookie mutations are 403, bearer-only clients pass, and existing Web mutation tests assert the CSRF header.

- [ ] **Step 6: Commit the security boundary**

```bash
git add src/auth/dashboard-csrf.ts src/auth/dashboard-session.ts src/middleware/admin-mutation-guard.ts src/routes/dashboard-login.ts src/index.ts shared/http shared web/src tests
git commit -m "Require proof of same-origin intent for dashboard mutations" \
  -m "Constraint: Remote cookie sessions and localhost browsers use ambient credentials; explicit bearer-only clients remain supported." \
  -m "Rejected: Relying on CORS or SameSite alone | neither covers every authenticated mutation path." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: CSRF store, mutation middleware, login, dashboard auth, admin client helper, Web mutation suite." \
  -m "Not-tested: Reverse-proxy deployment smoke remains for final verification."
```

### Task 3: Migrate configuration without changing operator intent

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `src/config-loader.ts`
- Modify: `config/default.yaml`
- Modify: `src/routes/admin/settings.ts`
- Modify: `shared/hooks/use-general-settings.ts`
- Modify: `web/src/components/GeneralSettings.tsx`
- Modify: `tests/unit/config-schema.test.ts`
- Modify: `tests/unit/config-loader.test.ts`
- Modify: `tests/unit/routes/general-settings.test.ts`
- Modify: `web/src/components/GeneralSettings.call-records.test.tsx`

- [ ] **Step 1: Add failing compatibility and bounds tests**

```ts
it("maps legacy call-record settings without changing semantic retention", () => {
  const config = loadFixture({ call_records: { retention_days: 30, max_body_bytes: 8192 } });
  expect(config.call_records).toMatchObject({
    raw_retention_days: 7,
    semantic_retention_days: 30,
    raw_max_body_bytes: 8192,
    semantic_max_text_bytes: 262_144,
    tool_summary_max_bytes: 65_536,
    outcome_retention_days: 90,
  });
});

it("rejects raw retention outside one to thirty days", () => {
  expect(() => ConfigSchema.parse({ call_records: { raw_retention_days: 31 } })).toThrow();
});
```

- [ ] **Step 2: Run the focused tests**

Run: `npx vitest run tests/unit/config-schema.test.ts tests/unit/config-loader.test.ts tests/unit/routes/general-settings.test.ts web/src/components/GeneralSettings.call-records.test.tsx`

Expected: FAIL because the approved field names are absent.

- [ ] **Step 3: Add the schema and one compatibility normalizer**

```ts
call_records: z.object({
  enabled: z.boolean().default(false),
  raw_retention_days: z.number().int().min(1).max(30).default(7),
  semantic_retention_days: z.number().int().positive().nullable().default(null),
  semantic_max_text_bytes: z.number().int().min(1024).default(262_144),
  tool_summary_max_bytes: z.number().int().min(1024).default(65_536),
  raw_max_body_bytes: z.number().int().min(1024).default(1_048_576),
  outcome_retention_days: z.number().int().min(7).max(365).default(90),
}).default({}),
```

Before schema parse in `config-loader.ts`, copy legacy `retention_days` to `semantic_retention_days` only when the new field is absent, and copy `max_body_bytes` to `raw_max_body_bytes` only when absent. Delete the legacy keys from the normalized in-memory object; do not rewrite the user's YAML during load.

- [ ] **Step 4: Update settings API and UI labels**

Return and accept the exact approved fields. Render separate “raw evidence retention” and “semantic retention” controls with the privacy explanation; preserve blank semantic retention as `null`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run tests/unit/config-schema.test.ts tests/unit/config-loader.test.ts tests/unit/routes/general-settings.test.ts web/src/components/GeneralSettings.call-records.test.tsx
```

Expected: PASS.

```bash
git add src/config-schema.ts src/config-loader.ts config/default.yaml src/routes/admin/settings.ts shared/hooks/use-general-settings.ts web/src/components/GeneralSettings.tsx tests/unit/config-schema.test.ts tests/unit/config-loader.test.ts tests/unit/routes/general-settings.test.ts web/src/components/GeneralSettings.call-records.test.tsx
git commit -m "Separate semantic history from temporary diagnostic evidence" \
  -m "Constraint: Existing retention_days and max_body_bytes values must retain their operator meaning during upgrade." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Config schema, legacy normalization, settings API, and Web settings tests." \
  -m "Not-tested: Existing local.yaml files are not rewritten automatically."
```

### Task 4: Implement version-1 semantic projection as pure functions

**Files:**
- Create: `src/call-records/semantic-projector.ts`
- Create: `src/call-records/semantic-request.ts`
- Create: `src/call-records/semantic-response.ts`
- Create: `tests/unit/call-records/semantic-projector.test.ts`
- Modify: `src/call-records/types.ts`
- Modify: `src/call-records/stream-response.ts`
- Modify: `tests/unit/call-records/stream-response.test.ts`

- [ ] **Step 1: Define the projection contract in a failing test**

```ts
it("keeps only the current turn and final folded response", () => {
  const result = projectCallSemantics({
    protocol: "responses",
    request: { input: [
      { role: "user", content: "old" }, { role: "assistant", content: "old answer" },
      { role: "user", content: "current question" },
    ], tools: [{ type: "function", name: "huge", parameters: { type: "object" } }] },
    response: [
      { event: "response.output_text.delta", data: { item_id: "m1", delta: "final " } },
      { event: "response.output_text.delta", data: { item_id: "m1", delta: "answer" } },
      { event: "response.completed", data: { status: "completed" } },
    ],
    limits: { textBytes: 262_144, toolBytes: 65_536 },
  });
  expect(result.requestText).toContain("current question");
  expect(result.requestText).not.toContain("old answer");
  expect(result.responseText).toBe("final answer");
  expect(result.toolSummaryText).not.toContain("parameters");
  expect(result.status).toBe("complete");
});
```

- [ ] **Step 2: Add protocol fixtures and verify failure**

Add cases for Chat Completions, Anthropic, Gemini, Responses, official-agent, tool-only completion, unknown event → `partial`, Unicode bounds, and system fingerprint stability.

Run: `npx vitest run tests/unit/call-records/semantic-projector.test.ts tests/unit/call-records/stream-response.test.ts`

Expected: FAIL on missing projector and accumulator APIs.

- [ ] **Step 3: Add explicit projection types**

```ts
export type ProjectionStatus = "complete" | "partial" | "failed";
export interface SemanticProjectionV1 {
  semanticVersion: 1;
  status: ProjectionStatus;
  reason: string | null;
  requestText: string;
  responseText: string;
  systemPreview: string;
  systemFingerprint: string | null;
  toolNames: string[];
  toolSummaryText: string;
  finishReason: string | null;
  messageCount: number;
  toolCallCount: number;
  eventCount: number;
  requestTextTruncated: boolean;
  responseTextTruncated: boolean;
  toolTextTruncated: boolean;
}
```

- [ ] **Step 4: Implement the pure dispatcher and Unicode-safe bound helper**

```ts
export function boundUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let output = "";
  for (const char of text) {
    if (Buffer.byteLength(output + char + "\n[…truncated]") > maxBytes) break;
    output += char;
  }
  return { text: `${output}\n[…truncated]`, truncated: true };
}

export function projectCallSemantics(input: SemanticProjectionInput): SemanticProjectionV1 {
  const request = extractCurrentTurn(input.protocol, input.request);
  const response = extractFinalResponse(input.protocol, input.response);
  const requestBound = boundUtf8(request.text, input.limits.textBytes);
  const responseBound = boundUtf8(response.text, input.limits.textBytes);
  const toolsBound = boundUtf8(response.toolSummary, input.limits.toolBytes);
  return {
    semanticVersion: 1,
    status: request.partial || response.partial ? "partial" : "complete",
    reason: request.reason ?? response.reason ?? null,
    requestText: requestBound.text,
    responseText: responseBound.text,
    systemPreview: request.systemPreview,
    systemFingerprint: request.systemFingerprint,
    toolNames: [...new Set(response.toolNames)],
    toolSummaryText: toolsBound.text,
    finishReason: response.finishReason,
    messageCount: request.messageCount,
    toolCallCount: response.toolCallCount,
    eventCount: response.eventCount,
    requestTextTruncated: requestBound.truncated,
    responseTextTruncated: responseBound.truncated,
    toolTextTruncated: toolsBound.truncated,
  };
}
```

Implement each protocol extractor with explicit role/item switches; never stringify the complete request as fallback. Extend the stream accumulator to fold text/tool deltas while retaining the existing bounded raw event result for the raw store.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/call-records/semantic-projector.test.ts tests/unit/call-records/stream-response.test.ts tests/unit/call-records/redact.test.ts`

Expected: PASS.

```bash
git add src/call-records/semantic-projector.ts src/call-records/semantic-request.ts src/call-records/semantic-response.ts src/call-records/stream-response.ts src/call-records/types.ts tests/unit/call-records/semantic-projector.test.ts tests/unit/call-records/stream-response.test.ts
git commit -m "Make call history describe meaning instead of protocol envelopes" \
  -m "Constraint: Never index repeated history, tool schemas, or raw delta streams as semantic content." \
  -m "Rejected: Frontend-only JSON parsing | historical search and storage would remain polluted." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: All protocol projections, stream folding, Unicode bounds, partial fallback, and redaction regression." \
  -m "Not-tested: Persistence is added in the next task."
```

### Task 5: Add the permanent v2 schema, raw store, and online backfill

**Files:**
- Create: `src/call-records/raw-store.ts`
- Create: `src/call-records/migration.ts`
- Create: `tests/unit/call-records/raw-store.test.ts`
- Modify: `src/call-records/store.ts`
- Modify: `tests/unit/call-records/store.test.ts`
- Modify: `tests/unit/call-records/migration.test.ts`

- [ ] **Step 1: Add failing schema, FTS, gzip, and resume tests**

```ts
it("indexes semantic text but not raw tool schemas", () => {
  store.insertSemantic(fixture({ requestText: "needle", rawRequest: { description: "raw-only-secret-term" } }));
  expect(store.list({ search: "needle" }).total).toBe(1);
  expect(store.list({ search: "raw-only-secret-term" }).total).toBe(0);
});

it("expires raw evidence without deleting semantic rows", () => {
  raw.insert(fixtureRaw({ callId: "call-1", expiresAt: "2026-07-10T00:00:00.000Z" }));
  expect(raw.cleanup(new Date("2026-07-18T00:00:00.000Z"))).toBe(1);
  expect(store.get("call-1")).not.toBeNull();
});

it("resumes migration after the saved rowid cursor", () => {
  migration.runBatch(1);
  const first = store.getMigrationState();
  migration.runBatch(1);
  expect(store.getMigrationState().cursorRowId).toBeGreaterThan(first.cursorRowId);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npx vitest run tests/unit/call-records/store.test.ts tests/unit/call-records/raw-store.test.ts tests/unit/call-records/migration.test.ts`

Expected: FAIL on missing semantic/raw/migration methods.

- [ ] **Step 3: Add the exact additive v2 tables**

```sql
CREATE TABLE IF NOT EXISTS call_record_content (
  call_id TEXT PRIMARY KEY REFERENCES call_records(id) ON DELETE CASCADE,
  request_text TEXT NOT NULL, response_text TEXT NOT NULL, system_preview TEXT NOT NULL,
  tool_names_json TEXT NOT NULL, tool_summary_text TEXT NOT NULL,
  request_text_truncated INTEGER NOT NULL, response_text_truncated INTEGER NOT NULL,
  tool_text_truncated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS call_outcome_buckets (
  bucket_start TEXT NOT NULL, outcome TEXT NOT NULL, protocol TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (bucket_start, outcome, protocol, provider, model)
);
CREATE TABLE IF NOT EXISTS call_record_migration (
  name TEXT PRIMARY KEY, cursor_rowid INTEGER NOT NULL, status TEXT NOT NULL,
  complete_count INTEGER NOT NULL, partial_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS call_records_semantic_fts USING fts5(
  request_text, response_text, tool_summary_text, context_label
);
PRAGMA user_version = 2;
```

Add the approved compact metadata columns to `call_records` with idempotent `ALTER TABLE` checks. Do not drop `request_json` or `response_json` in this plan.

- [ ] **Step 4: Implement raw gzip rows and bounded decompression**

Use `gzipSync`/`gunzipSync`, SHA-256 the compressed blobs, enforce the configured decompressed maximum before JSON parse, and return `available|expired|missing|unavailable`. Raw DB schema is exactly the approved `call_raw_evidence` table.

- [ ] **Step 5: Implement resumable batch projection and dual reads**

`runBatch(limit)` selects legacy rows where `rowid > cursor`, projects them with `projectCallSemantics()`, inserts content and semantic FTS in one transaction, copies only in-window raw evidence, saves counts/cursor, and marks complete only after no rows remain. `get()` and `list()` use semantic fields when present and fall back to legacy previews during backfill.

For legacy rows inside `outcome_retention_days`, upsert only the known `success` bucket derived from `completed_at`; do not create historical failure, interruption, or retry counts because schema v1 never captured them.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run tests/unit/call-records/store.test.ts tests/unit/call-records/raw-store.test.ts tests/unit/call-records/migration.test.ts
```

Expected: PASS, including schema-v1 fixture and CJK `LIKE` fallback over semantic fields.

```bash
git add src/call-records/store.ts src/call-records/raw-store.ts src/call-records/migration.ts tests/unit/call-records/store.test.ts tests/unit/call-records/raw-store.test.ts tests/unit/call-records/migration.test.ts
git commit -m "Keep durable analysis independent from expiring diagnostic evidence" \
  -m "Constraint: Schema-v1 rows remain readable throughout resumable additive backfill." \
  -m "Rejected: Dropping legacy JSON in place | rollback and size reclamation would be unsafe." \
  -m "Confidence: high" -m "Scope-risk: broad" \
  -m "Tested: V2 schema, semantic FTS, gzip integrity, raw expiry, dual reads, resumable migration." \
  -m "Not-tested: Final compact-file swap is intentionally deferred to plan four."
```

### Task 6: Change recorder ordering and isolate raw failures

**Files:**
- Modify: `src/call-records/recorder.ts`
- Modify: `src/call-records/service.ts`
- Modify: `src/call-records/capture.ts`
- Modify: `tests/unit/call-records/recorder.test.ts`
- Modify: `tests/unit/call-records/service.test.ts`

- [ ] **Step 1: Add failing ordering/idempotency tests**

```ts
it("commits semantic success before best-effort raw evidence", () => {
  rawStore.insert.mockImplementation(() => { throw new Error("disk full"); });
  expect(recorder.finalizeSuccessfulCall(pending, result)).toBe(true);
  expect(store.insertSemantic).toHaveBeenCalledOnce();
  expect(rawStore.insert).toHaveBeenCalledAfter(store.insertSemantic);
});

it("does not double-count a duplicate request id", () => {
  recorder.finalizeSuccessfulCall(pending, result);
  recorder.finalizeSuccessfulCall(pending, result);
  expect(store.insertSemantic).toHaveBeenCalledOnce();
  expect(store.getOutcomeCount("success")).toBe(1);
});
```

- [ ] **Step 2: Run focused tests**

Run: `npx vitest run tests/unit/call-records/recorder.test.ts tests/unit/call-records/service.test.ts`

Expected: FAIL because recorder still serializes raw JSON into the permanent row and has no raw store.

- [ ] **Step 3: Implement semantic-first finalization**

In `finalizeSuccessfulCall()`: redact once, project semantic content, serialize bounded raw evidence, call `store.insertSemantic()` (which includes the success bucket transaction), and only after `inserted === true` call `rawStore.insert()`. Raw failure calls a separate `onRawError` and returns `true`; permanent failure returns `false`; both paths null `pending.request` in `finally`.

- [ ] **Step 4: Initialize two stores and bounded maintenance**

`initializeCallRecordService()` opens permanent and raw paths under `getDataDir()`, starts short unref'd batches for backfill and daily bounded cleanup, and continues with permanent-only mode if raw initialization fails. `closeCallRecordService()` stops timers and closes both stores.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/call-records/recorder.test.ts tests/unit/call-records/service.test.ts tests/integration/call-records-proxy.test.ts`

Expected: PASS; raw failure does not change successful response or semantic row.

```bash
git add src/call-records/recorder.ts src/call-records/service.ts src/call-records/capture.ts tests/unit/call-records/recorder.test.ts tests/unit/call-records/service.test.ts tests/integration/call-records-proxy.test.ts
git commit -m "Preserve useful call history when raw evidence cannot be written" \
  -m "Constraint: Observability failures never alter a semantically completed proxy response." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Recorder ordering, duplicate finalization, raw degradation, service cleanup, proxy integration." \
  -m "Not-tested: Outcome retries are wired in the next task."
```

### Task 7: Count actual model dispatches and one terminal outcome

**Files:**
- Create: `src/call-records/outcome-tracker.ts`
- Create: `tests/unit/call-records/outcome-tracker.test.ts`
- Modify: `src/call-records/types.ts`
- Modify: `src/call-records/capture.ts`
- Modify: `src/utils/retry.ts`
- Modify: `src/routes/shared/proxy-upstream-attempt.ts`
- Modify: `src/routes/shared/non-streaming-helpers.ts`
- Modify: `src/routes/shared/direct-request-handler.ts`
- Modify: `src/routes/shared/proxy-handler.ts`
- Modify: `src/routes/shared/streaming-handler.ts`
- Modify: `src/routes/shared/non-streaming-handler.ts`
- Modify: `src/proxy/codex-api.ts`
- Modify: `src/proxy/ws-transport.ts`
- Modify: `src/codex-app-server/client.ts`
- Modify: `src/routes/official-agent.ts`
- Test: corresponding existing retry/stream/direct/official tests plus new tracker test

- [ ] **Step 1: Add failing state-machine and nested-dispatch tests**

```ts
it("counts only the second and later actual dispatch as retry", () => {
  const tracker = createCallOutcomeTracker({ requestId: "r1", protocol: "responses", model: "gpt" });
  expect(tracker.beginUpstreamAttempt({ provider: "codex" })).toBe(1);
  expect(tracker.beginUpstreamAttempt({ provider: "codex" })).toBe(2);
  tracker.finalize("success");
  tracker.finalize("failure");
  expect(tracker.snapshot()).toMatchObject({ attempts: 2, retries: 1, terminal: "success" });
});

it("calls onAttempt for every retry wrapper dispatch when the wrapped adapter has no inner fallback", async () => {
  const onAttempt = vi.fn();
  await withRetry(failTwiceThenSucceed(), { baseDelayMs: 0, onAttempt });
  expect(onAttempt).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 2: Run tracker and retry-path tests**

Run:

```bash
npx vitest run tests/unit/call-records/outcome-tracker.test.ts tests/unit/utils/retry.test.ts tests/unit/routes/shared/proxy-upstream-attempt.test.ts tests/unit/routes/shared/non-streaming-empty-response-retry.test.ts tests/unit/routes/shared/proxy-retry-classifier.test.ts tests/unit/routes/shared/proxy-error-retry-transition.test.ts
```

Expected: FAIL on missing tracker and `onAttempt` option.

- [ ] **Step 3: Implement the request-owned tracker**

```ts
export function createCallOutcomeTracker(input: OutcomeTrackerInput): CallOutcomeTracker {
  let attempts = 0;
  let terminal: CallTerminalOutcome | null = null;
  let lastProvider = "unknown";
  return {
    beginUpstreamAttempt(meta) {
      attempts += 1;
      lastProvider = meta.provider;
      if (attempts > 1) input.recordBucket("retry", meta.provider, input.model);
      return attempts;
    },
    finalize(outcome) {
      if (terminal) return false;
      terminal = outcome;
      if (outcome !== "success") input.recordBucket(outcome, lastProvider, input.model);
      return true;
    },
    snapshot: () => ({ attempts, retries: Math.max(0, attempts - 1), terminal }),
  };
}
```

Attach it to `PendingCallRecord`. Successful permanent insert finalizes success in the same transaction; failure/interruption finalization records only buckets. Define a `ModelDispatchObserver` callback type that transports receive without depending on the call-record store.

- [ ] **Step 4: Put hooks at actual dispatch points**

Add `onAttempt?: () => void` to `withRetry` and invoke it immediately before every `fn()` call, but use that option only when one wrapper invocation equals one actual model dispatch.

For Codex, pass one `ModelDispatchObserver` through `sendProxyUpstreamAttempt()` into `CodexApi.createResponse()` and do **not** count at the outer `withRetry` call. Invoke it at the exact HTTP request write, pooled/fresh WS `response.create` send, and WS→HTTP fallback send. A retry wrapper around `CodexApi.createResponse()` therefore delegates counting to those inner transport sends and cannot double-count the first attempt.

Use the same observer for `retryNonStreamingEmptyResponse()`; do not add a second counter around its `withRetry`. In a direct provider adapter with no inner fallback, invoke immediately before `upstream.createResponse()` (or use `withRetry.onAttempt` if a retry wrapper is later introduced). In official-agent, invoke only for JSON-RPC `turn/start`, not thread/list/init messages.

Add explicit assertions: one successful Codex HTTP send → attempts 1; WS send followed by HTTP fallback → attempts 2/retries 1; an outer 5xx retry whose two `CodexApi.createResponse()` calls each perform one HTTP send → attempts 2, not 4; empty-response account retry → exactly one additional dispatch.

- [ ] **Step 5: Centralize terminal classification**

Call `finalize("interrupted")` for downstream abort or post-start stream termination; `finalize("failure")` for another terminal unsuccessful route; success remains inside semantic insert. Do not add counters inside `classifyRetryAction()` or other decision helpers.

- [ ] **Step 6: Run the complete dispatch matrix**

Run:

```bash
npx vitest run tests/unit/call-records/outcome-tracker.test.ts tests/unit/utils/retry.test.ts tests/unit/routes/shared/proxy-upstream-attempt.test.ts tests/unit/routes/shared/non-streaming-empty-response-retry.test.ts tests/unit/routes/shared/proxy-error-retry-transition.test.ts tests/unit/routes/shared/streaming-handler.test.ts tests/unit/routes/shared/non-streaming-handler-boundary.test.ts tests/unit/routes/official-agent.test.ts tests/integration/call-records-proxy.test.ts
```

Expected: PASS; every additional model dispatch produces exactly one retry bucket, terminal outcome is idempotent, and failures retain no body row.

- [ ] **Step 7: Commit the outcome boundary**

```bash
git add src/call-records src/utils/retry.ts src/routes/shared src/proxy/codex-api.ts src/proxy/ws-transport.ts src/codex-app-server/client.ts src/routes/official-agent.ts tests
git commit -m "Count model attempts where work is actually dispatched" \
  -m "Constraint: Nested retry decisions must neither miss transport fallbacks nor double-count one dispatch." \
  -m "Rejected: Counting high-level retry branches | several paths resend inside lower transport helpers." \
  -m "Confidence: high" -m "Scope-risk: broad" \
  -m "Tested: Retry utility, Codex dispatch, empty response, WS fallback, direct provider, official agent, terminal outcomes." \
  -m "Not-tested: Dashboard aggregation is implemented in plan three."
```

### Task 8: Complete foundation verification

**Files:**
- Modify only if verification exposes a defect in files owned by Tasks 1–7.

- [ ] **Step 1: Run all call-record, retry, auth, config, and settings tests**

```bash
npx vitest run \
  tests/unit/call-records \
  tests/unit/middleware/admin-mutation-guard.test.ts \
  tests/unit/middleware/dashboard-auth.test.ts \
  tests/unit/auth/dashboard-csrf.test.ts \
  tests/unit/routes/dashboard-login.test.ts \
  tests/unit/routes/general-settings.test.ts \
  tests/unit/routes/shared/proxy-upstream-attempt.test.ts \
  tests/unit/routes/shared/non-streaming-empty-response-retry.test.ts \
  tests/integration/call-records-proxy.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run typecheck and production build**

Run: `npm run build`

Expected: Vite Web build and TypeScript compilation both exit 0.

- [ ] **Step 3: Inspect the physical databases in a temporary fixture**

Run a targeted test helper that inserts one success, one failure, one retry and then asserts:

```sql
SELECT COUNT(*) FROM call_records;              -- 1
SELECT COUNT(*) FROM call_record_content;       -- 1
SELECT SUM(count) FROM call_outcome_buckets;    -- 3: success + failure + retry
SELECT COUNT(*) FROM call_records_semantic_fts; -- 1
```

Verify the raw database contains only the successful call and that cleanup removes it without changing the permanent counts.

- [ ] **Step 4: Commit only verification fixes, if any**

If no fixes were necessary, do not create an empty commit. If fixes were necessary:

Stage only the exact files changed to correct the observed failure, then run:

```bash
git diff --cached --name-only
git commit -m "Close the verified gaps in the call data foundation" \
  -m "Constraint: Only defects exposed by the complete foundation verification are in scope." \
  -m "Confidence: high" -m "Scope-risk: narrow" \
  -m "Tested: Full foundation test matrix and npm run build." \
  -m "Not-tested: UI dashboard and compact-file cutover remain in later plans."
```

## Foundation completion gate

Do not start the Web shell or observability dashboard plans until:

- schema-v1 rows dual-read and backfill without loss;
- permanent semantic insert and raw write ordering are proven;
- semantic FTS excludes raw protocol noise;
- failed bodies are absent and outcome counters are dispatch-accurate;
- every browser `/admin/*` mutation passes the CSRF guard and Web helper;
- raw cleanup preserves semantic rows;
- `npm run build` passes.
