# Successful Call Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one searchable, redacted SQLite record for every semantically successful proxy call and expose those records through an authenticated Dashboard page.

**Architecture:** Route adapters create a pending capture from the original client request and explicit grouping headers. The existing Codex and direct-upstream completion paths finalize the capture exactly once with response, usage, provider, account, and effective conversation metadata; a focused recorder redacts and bounds content before writing two SQLite tables plus an optional FTS5 index. Authenticated admin APIs serve flat and grouped queries to a Preact page that follows the current Logs page patterns.

**Tech Stack:** TypeScript, Hono, `better-sqlite3`, Zod, Preact, Tailwind CSS, Vitest.

---

## File Map

### New backend files

- `src/call-records/types.ts`: capture, context, persisted row, query, and API types.
- `src/call-records/redact.ts`: recursive secret/value redaction, binary replacement, and bounded JSON serialization.
- `src/call-records/context.ts`: explicit header and protocol fallback identity resolution.
- `src/call-records/stream-response.ts`: bounded reconstruction of translated streaming output.
- `src/call-records/store.ts`: SQLite schema, writes, filters, grouping, retention, clear, and store state.
- `src/call-records/recorder.ts`: pending-capture creation and idempotent success finalization.
- `src/routes/admin/call-records.ts`: authenticated list/detail/context/state/clear APIs.

### Modified backend files

- `src/config-schema.ts`, `config/default.yaml`: privacy-safe defaults.
- `src/hono-context.ts`: typed pending capture context variable.
- `src/routes/chat.ts`, `src/routes/messages.ts`, `src/routes/gemini.ts`, `src/routes/responses.ts`: initialize capture from original request and protocol metadata.
- `src/routes/shared/proxy-handler-types.ts`: carry protocol/capture metadata through shared handlers.
- `src/routes/shared/proxy-handler.ts`: enrich capture with effective conversation identity.
- `src/routes/shared/streaming-handler.ts`: reconstruct client output and finalize only after completed stream.
- `src/routes/shared/non-streaming-handler.ts`: finalize after successful translation.
- `src/routes/shared/direct-request-handler.ts`: finalize successful direct streaming/non-streaming calls.
- `src/routes/official-agent.ts`: capture completed thread turns with thread ID and cwd.
- `src/routes/web.ts`, `src/index.ts`: initialize/inject the store and mount routes.
- `src/routes/admin/settings.ts`: read/write capture settings.

### New web/shared files

- `shared/hooks/use-call-records.ts`: server-side filters, pagination, grouping, details, state, and clear actions.
- `web/src/pages/CallRecordsPage.tsx`: Call Records Dashboard page.

### Modified web/shared files

- `web/src/App.tsx`: navigation and page mount.
- `web/src/components/GeneralSettings.tsx`: enable, retention, size limit, and privacy warning.
- `shared/hooks/use-general-settings.ts`: settings transport types.
- `shared/i18n/translations.ts`: Chinese/English strings.

### Tests

- `tests/unit/call-records/redact.test.ts`
- `tests/unit/call-records/context.test.ts`
- `tests/unit/call-records/stream-response.test.ts`
- `tests/unit/call-records/store.test.ts`
- `tests/unit/call-records/recorder.test.ts`
- `tests/unit/routes/call-records.test.ts`
- `tests/integration/call-records-proxy.test.ts`
- `web/src/pages/__tests__/call-records.test.tsx`
- existing settings, handler, and App tests updated where their public contract changes.

## Task 1: Configuration Contract

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `config/default.yaml`
- Modify: `tests/unit/config-schema.test.ts`
- Modify: `tests/unit/config.test.ts`

- [ ] **Step 1: Add failing schema/default assertions**

Assert parsed defaults are:

```ts
expect(result.call_records).toEqual({
  enabled: false,
  retention_days: null,
  max_body_bytes: 1_048_576,
});
```

Also assert `retention_days` rejects zero/negative numbers and `max_body_bytes` rejects values below 1 KiB.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/unit/config-schema.test.ts tests/unit/config.test.ts`

Expected: failures because `call_records` does not exist.

- [ ] **Step 3: Add the Zod and YAML configuration**

Add:

```ts
call_records: z.object({
  enabled: z.boolean().default(false),
  retention_days: z.number().int().positive().nullable().default(null),
  max_body_bytes: z.number().int().min(1024).default(1_048_576),
}).default({}),
```

Add matching values to `config/default.yaml` without changing the user's local overlay.

- [ ] **Step 4: Run the focused tests**

Expected: PASS.

- [ ] **Step 5: Commit the configuration contract**

Use a Lore commit whose intent is to make content persistence explicit and opt-in.

## Task 2: Redaction and Bounded Serialization

**Files:**
- Create: `src/call-records/redact.ts`
- Create: `tests/unit/call-records/redact.test.ts`
- Reuse: `src/logs/redact.ts`

- [ ] **Step 1: Write failing tests for recursive redaction**

Cover nested `authorization`, `cookie`, `api_key`, `access_token`, `refreshToken`, `password`, JWT/bearer-shaped values, and email-like values. Verify ordinary prompt text remains intact.

- [ ] **Step 2: Write failing tests for binary and body bounds**

Verify long base64/image data becomes:

```ts
{ redacted_binary: true, media_type: "image/png", bytes: 4096 }
```

Verify `serializeBounded(value, 1024)` returns valid JSON, original byte count, and `truncated: true` without cutting a UTF-8 sequence or emitting invalid JSON.

- [ ] **Step 3: Run tests and confirm failure**

Run: `npx vitest run tests/unit/call-records/redact.test.ts`

- [ ] **Step 4: Implement minimal redaction and serialization**

Export:

```ts
export interface BoundedJson {
  json: string;
  originalBytes: number;
  truncated: boolean;
}

export function redactCallContent(value: unknown): unknown;
export function serializeBounded(value: unknown, maxBytes: number): BoundedJson;
```

Reuse existing key redaction behavior where compatible, extend it for token-shaped values, and replace oversized subtrees with structured truncation markers before final serialization.

- [ ] **Step 5: Run tests and commit**

Expected: PASS with no content leaks in snapshots/error output.

## Task 3: Context Identity Resolution

**Files:**
- Create: `src/call-records/types.ts`
- Create: `src/call-records/context.ts`
- Create: `tests/unit/call-records/context.test.ts`
- Modify: `src/routes/shared/proxy-handler-types.ts`

- [ ] **Step 1: Define capture and identity types in tests**

The public resolver input and result are:

```ts
interface CallContextHints {
  explicitSessionId?: string;
  explicitTaskId?: string;
  explicitCwd?: string;
  protocolSessionId?: string;
  protocolTaskId?: string;
  protocolCwd?: string;
  derivedConversationId?: string;
  source: string;
}

interface ResolvedCallContext {
  sessionId: string | null;
  taskId: string | null;
  cwd: string | null;
  source: string;
  contextKey: string | null;
}
```

Test explicit-over-protocol precedence, whitespace/length rejection, missing identity, and stable SHA-256 key generation.

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run tests/unit/call-records/context.test.ts`

- [ ] **Step 3: Implement resolver and request-header helper**

Export `resolveCallContext(hints)` and `readExplicitCallContextHeaders(headers)`. Never parse arbitrary prompt prose and never use request ID as a context key.

- [ ] **Step 4: Extend `ProxyRequest` with optional capture metadata**

Add a single optional `callRecord` field referencing a `PendingCallRecord`; do not scatter session/task/cwd fields across handlers.

- [ ] **Step 5: Run tests/typecheck and commit**

Run: `npx vitest run tests/unit/call-records/context.test.ts && npx tsc --noEmit`.

## Task 4: SQLite Store

**Files:**
- Create: `src/call-records/store.ts`
- Create: `tests/unit/call-records/store.test.ts`

- [ ] **Step 1: Write schema and insert tests against temporary databases**

Assert WAL/busy-timeout initialization, `user_version = 1`, both core tables, required indexes, context upsert, and unique `request_id` idempotency. Inject the database path so tests never touch `data/`.

- [ ] **Step 2: Write query tests**

Insert at least six calls spanning contexts/models/providers/accounts/protocols/time ranges. Test every allowlisted filter, both sort directions, pagination, previews, context aggregation, detail lookup, state, clear, and retention.

- [ ] **Step 3: Write FTS fallback tests**

Test FTS search when available and force an injected no-FTS mode to verify escaped `LIKE` search. Search terms must be bound parameters, never SQL fragments.

- [ ] **Step 4: Run tests and confirm failure**

Run: `npx vitest run tests/unit/call-records/store.test.ts`.

- [ ] **Step 5: Implement `CallRecordStore`**

Expose:

```ts
class CallRecordStore {
  insert(record: CompletedCallRecord): boolean;
  list(query: CallRecordQuery): CallRecordPage;
  get(id: string): CallRecordDetail | null;
  listContexts(query: CallContextQuery): CallContextPage;
  getState(): CallRecordStoreState;
  cleanup(retentionDays: number | null): number;
  clear(): void;
  close(): void;
}
```

Use a transaction for context upsert plus call insert. Store bodies only after redaction/bounding by the recorder.

- [ ] **Step 6: Run tests and commit**

Expected: all store tests PASS and temporary databases are closed/deleted.

## Task 5: Pending Capture and Final Recorder

**Files:**
- Create: `src/call-records/recorder.ts`
- Create: `tests/unit/call-records/recorder.test.ts`
- Modify: `src/hono-context.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Test that `createPendingCall` records start metadata and original request without persistence. Test that `finalizeSuccessfulCall` resolves/enriches context, normalizes missing usage values to zero, redacts/bounds both bodies, inserts once, and swallows/logs store failures.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run tests/unit/call-records/recorder.test.ts`.

- [ ] **Step 3: Implement the recorder**

Use dependency injection:

```ts
export function createCallRecorder(options: {
  store: CallRecordStore;
  isEnabled: () => boolean;
  maxBodyBytes: () => number;
  now?: () => number;
  onError?: (error: unknown, requestId: string) => void;
}): CallRecorder;
```

The returned recorder owns a `WeakSet` or pending-state flag for idempotent finalization. Disabled capture must avoid retaining request bodies.

- [ ] **Step 4: Type the Hono context value**

Add an optional `callRecord` context value only if route-level storage is needed; otherwise keep pending capture on `ProxyRequest` and document that choice in the commit.

- [ ] **Step 5: Run tests/typecheck and commit**

## Task 6: Streaming Response Reconstruction

**Files:**
- Create: `src/call-records/stream-response.ts`
- Create: `tests/unit/call-records/stream-response.test.ts`
- Modify: `src/routes/shared/response-processor.ts`

- [ ] **Step 1: Write failing protocol reconstruction tests**

Feed fragmented OpenAI, Anthropic, Gemini, and Responses SSE chunks. Assert semantic output contains final text/reasoning/tool calls once, excludes SSE framing and heartbeat comments, handles chunk boundaries, and returns valid bounded JSON.

- [ ] **Step 2: Test completion/write semantics**

Assert chunks are observed only after `writer.write` resolves. A rejected client write must not add the failed chunk or produce a successful capture.

- [ ] **Step 3: Run tests and confirm failure**

Run: `npx vitest run tests/unit/call-records/stream-response.test.ts`.

- [ ] **Step 4: Implement a protocol-aware accumulator**

Export:

```ts
interface StreamResponseCapture {
  appendWrittenChunk(chunk: string): void;
  finish(): unknown;
}

export function createStreamResponseCapture(protocol: CallProtocol): StreamResponseCapture;
```

Add an optional `onChunkWritten` callback to `streamResponse` and call it immediately after successful `writer.write`.

- [ ] **Step 5: Run focused response-processor tests and commit**

Include existing streaming-handler/response-processor tests to prove unchanged client output.

## Task 7: Route Capture Initialization

**Files:**
- Modify: `src/routes/chat.ts`
- Modify: `src/routes/messages.ts`
- Modify: `src/routes/gemini.ts`
- Modify: `src/routes/responses.ts`
- Modify: `src/routes/shared/proxy-handler.ts`
- Modify: relevant route unit tests

- [ ] **Step 1: Add failing route tests for metadata precedence**

For every route, assert original parsed request, route/protocol/model/stream, explicit proxy headers, and existing protocol session IDs reach `ProxyRequest.callRecord`. Include Responses turn metadata and parent thread ID.

- [ ] **Step 2: Run the focused route tests and confirm failure**

- [ ] **Step 3: Create pending captures at route entry**

Use one shared helper so all routes apply identical header trimming and privacy behavior. Do not put headers into persisted request JSON.

- [ ] **Step 4: Enrich Codex calls with effective conversation identity**

In `proxy-handler.ts`, add `sessionContext.chainConversationId` only as the lowest-priority derived fallback before handing control to final response handlers.

- [ ] **Step 5: Run tests/typecheck and commit**

## Task 8: Finalize Codex and Direct Calls

**Files:**
- Modify: `src/routes/shared/streaming-handler.ts`
- Modify: `src/routes/shared/non-streaming-handler.ts`
- Modify: `src/routes/shared/direct-request-handler.ts`
- Modify: `src/index.ts`
- Test: existing handler tests plus `tests/integration/call-records-proxy.test.ts`

- [ ] **Step 1: Write failing non-streaming success/failure tests**

Assert successful translation finalizes once with the client response. Translation error, exhausted empty response, and upstream error finalize zero times. A final success after retry records the final account/provider only.

- [ ] **Step 2: Write failing streaming success/failure tests**

Assert finalization requires `onResponseCompleted`, usage, and a clean stream return. Client abort, client write failure, upstream error, or premature close records nothing.

- [ ] **Step 3: Write direct-upstream tests**

Assert direct OpenAI/Anthropic/Gemini success records provider/usage/body for both stream modes. Direct handler must replace current no-op `onUsage` callbacks.

- [ ] **Step 4: Run tests and confirm failure**

Run: `npx vitest run tests/unit/routes/shared/streaming-handler.test.ts tests/unit/routes/shared/non-streaming-handler.test.ts tests/unit/routes/shared/direct-request-handler.test.ts tests/integration/call-records-proxy.test.ts`.

- [ ] **Step 5: Inject and finalize through one recorder instance**

Construct the store/recorder during server startup and inject it into route/handler factories. Avoid mutable module-global state in tests. Close the store when the server handle closes.

- [ ] **Step 6: Run focused tests and commit**

## Task 9: Official Agent Capture

**Files:**
- Modify: `src/routes/official-agent.ts`
- Modify: `src/codex-app-server/types.ts` if completion metadata typing is missing
- Test: `tests/unit/routes/official-agent.test.ts`

- [ ] **Step 1: Add failing tests**

Assert a completed turn records `threadId` as task/session identity, supplied cwd, request input, final streamed notifications normalized as response, model, token usage when available, and latency. Aborted/error turns record nothing.

- [ ] **Step 2: Run tests and confirm failure**

- [ ] **Step 3: Wire the existing thread-turn completion boundary to the recorder**

Do not duplicate app-server NDJSON/SSE frames; accumulate semantic notification payloads within the same body bound.

- [ ] **Step 4: Run tests and commit**

## Task 10: Authenticated Admin API

**Files:**
- Create: `src/routes/admin/call-records.ts`
- Create: `tests/unit/routes/call-records.test.ts`
- Modify: `src/routes/web.ts`
- Modify: `tests/integration/error-logs-dashboard-auth.test.ts` or add equivalent dashboard-auth coverage

- [ ] **Step 1: Write failing API validation and response tests**

Cover all list filters, allowlisted sort/order values, `limit <= 200`, detail `404`, context aggregates, state, and clear. Assert list previews exclude full bodies while detail includes them.

- [ ] **Step 2: Write failing authentication tests**

Assert all `/admin/call-records*` and `/admin/call-contexts` endpoints follow the existing Dashboard auth gate.

- [ ] **Step 3: Run tests and confirm failure**

- [ ] **Step 4: Implement Zod-validated routes and mount them**

Return `400` issues for invalid filters. Never expose a raw SQL parameter or credential-bearing account data.

- [ ] **Step 5: Run tests and commit**

## Task 11: Settings API and Dashboard Controls

**Files:**
- Modify: `src/routes/admin/settings.ts`
- Modify: `shared/hooks/use-general-settings.ts`
- Modify: `web/src/components/GeneralSettings.tsx`
- Modify: `shared/i18n/translations.ts`
- Modify: `tests/unit/routes/general-settings.test.ts`
- Modify: corresponding web settings tests

- [ ] **Step 1: Add failing backend settings tests**

Test read/write/validation for `call_records_enabled`, `call_records_retention_days`, and `call_records_max_body_bytes`. Verify YAML mutation touches only `call_records` keys.

- [ ] **Step 2: Add failing web control tests**

Test opt-in checkbox, privacy warning, nullable retention, byte-limit validation, save payload, and disabled-capture explanation.

- [ ] **Step 3: Run tests and confirm failure**

- [ ] **Step 4: Implement backend and frontend settings**

Use translated Chinese/English copy that states request and response content is stored locally and existing records remain when capture is disabled.

- [ ] **Step 5: Run tests and commit**

## Task 12: Call Records Hook and Page

**Files:**
- Create: `shared/hooks/use-call-records.ts`
- Create: `web/src/pages/CallRecordsPage.tsx`
- Create: `web/src/pages/__tests__/call-records.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `shared/i18n/translations.ts`

- [ ] **Step 1: Write failing hook/query-state tests**

Test debounced search, server query encoding, pagination reset on any filter, flat/grouped switching, context drill-down, details, state refresh, and clear action.

- [ ] **Step 2: Write failing page tests**

Cover loading, empty, error, flat results, grouped results, filters, sort controls, detail tabs, truncation warnings, JSON copy, state/disk indicators, and clear confirmation.

- [ ] **Step 3: Write failing navigation/i18n tests**

Assert `#/call-records` is visible and mounts the page in English and Chinese.

- [ ] **Step 4: Run web tests and confirm failure**

Run: `cd web && npx vitest run src/pages/__tests__/call-records.test.tsx src/App.test.tsx`.

- [ ] **Step 5: Implement hook and page**

Follow `LogsPage` layout patterns but keep filters server-side. Render request/response JSON only after detail selection; do not preload full bodies in list mode.

- [ ] **Step 6: Run web tests/build and commit**

Run: `npm run test:web && npm run build:web`.

## Task 13: Retention Lifecycle and Documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `API.md`
- Modify: `API_CN.md`
- Modify: `CHANGELOG.md`
- Test: lifecycle tests near store/server tests

- [ ] **Step 1: Add failing lifecycle tests**

Use fake timers to prove bounded cleanup runs only when retention is configured, stops when the server closes, and does not block startup or proxy responses on failure.

- [ ] **Step 2: Implement cleanup lifecycle**

Run one cleanup after store initialization and schedule a daily unref'd cleanup timer. Clear it and close SQLite in `ServerHandle.close`.

- [ ] **Step 3: Document configuration, headers, APIs, privacy, and limitations**

Document the three explicit `x-codex-proxy-*` headers, fallback identities, successful-only semantics, body truncation, local database path, Dashboard page, and no-scoring MVP boundary in both languages.

- [ ] **Step 4: Run lifecycle tests and commit**

## Task 14: Full Verification

**Files:**
- Inspect all changed files only; do not fix unrelated failures.

- [ ] **Step 1: Run targeted backend tests**

```bash
npx vitest run tests/unit/call-records tests/unit/routes/call-records.test.ts tests/integration/call-records-proxy.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run affected handler/settings tests**

```bash
npx vitest run tests/unit/routes/shared/streaming-handler.test.ts tests/unit/routes/shared/non-streaming-handler.test.ts tests/unit/routes/shared/direct-request-handler.test.ts tests/unit/routes/general-settings.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run all web tests and build**

```bash
npm run test:web
npm run build:web
```

Expected: PASS.

- [ ] **Step 4: Run root typecheck/build and full test suite**

```bash
npx tsc --noEmit
npm test
npm run build
```

Expected: PASS. Report unrelated pre-existing failures without modifying their code.

- [ ] **Step 5: Run static checks and inspect the final diff**

```bash
git diff --check
git status --short
git diff --stat HEAD~1
```

Confirm no data databases, local YAML, `.env`, generated public assets beyond the normal build policy, or user-owned dirty files are included.

- [ ] **Step 6: Perform a final requirement audit**

Confirm: successful calls only; one row per request; all required routes; redacted/bounded bodies; contexts and cwd; SQLite retrieval; authenticated page; FTS fallback; opt-in default; no scoring/evaluation code.
