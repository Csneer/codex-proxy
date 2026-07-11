# Successful Call Records MVP

## Purpose

Add durable, searchable records of successful LLM calls to Codex Proxy. The records support later analysis of personal usage patterns and token efficiency. This MVP stores and retrieves data; it does not score call quality or generate optimization advice.

## Scope

The MVP:

- records exactly one durable row for each final successful LLM call;
- stores redacted request and response bodies;
- records model, provider, account, latency, token usage, response identity, and streaming mode;
- organizes calls by session, task, and working directory when those identities are available;
- provides authenticated admin APIs for filtering, pagination, detail retrieval, and grouping;
- adds a Dashboard page for list, grouped, full-text search, and detail views;
- uses a separate local SQLite database at `data/call-records.sqlite`.

The MVP does not:

- record failed calls, individual retry attempts, ingress/egress audit events, or stream chunks;
- score request or response quality;
- estimate cost or recommend optimizations;
- infer task quality from prompt contents;
- require Langfuse, OpenTelemetry collectors, PostgreSQL, or any external service.

## Existing Constraints

Codex Proxy already has two observability mechanisms, but neither is a per-call durable analysis store:

- `LogStore` is an in-memory ring buffer. It is bounded, optional, and lost on restart.
- `UsageStatsStore` persists cumulative snapshots. It can show time-series totals but cannot reconstruct individual calls.

The project already depends on `better-sqlite3` and already has a SQLite compatibility approach in account persistence. The new store reuses the installed dependency but remains isolated from account credentials.

## External Model References

The design follows the minimal common shape used by established LLM observability models:

- OpenTelemetry GenAI conventions associate individual operations with conversation identifiers and record model and token usage attributes.
- Langfuse separates sessions from traces and observations/generations.

Codex Proxy only needs two layers for this MVP: a context groups related work, and a call represents one successful model invocation.

References:

- https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- https://langfuse.com/docs/observability/data-model

## Architecture

### Call Context

A context groups calls that belong to the same client session, task, or working directory. Context identity is resolved conservatively from explicit protocol data. Missing identity remains missing; the proxy does not derive durable identifiers by parsing arbitrary prompt prose.

Identity source priority:

1. Explicit proxy headers:
   - `x-codex-proxy-session-id`
   - `x-codex-proxy-task-id`
   - `x-codex-proxy-cwd`
2. Existing route-specific values:
   - OpenAI Chat Completions: `user`
   - Anthropic Messages: `x-claude-code-session-id`, then `metadata.user_id.session_id`
   - Gemini: `x-conversation-id`, then `x-session-id`
   - Responses: Codex turn metadata/session fields and existing client conversation identity
   - Official agent: `threadId` and `cwd`
3. Existing stable proxy conversation identity when it is already derived for affinity.

Explicit proxy headers override route-specific fallbacks. Empty and invalid values are ignored. Working directories are stored as supplied after trimming and length validation; the proxy does not access the path or require it to exist on the proxy host.

Calls with no grouping identity remain queryable as ungrouped calls. The store never fabricates a session from request ID because that would create a meaningless one-call session.

### Successful Call

A successful call is recorded only after the response has semantically completed:

- Non-streaming: the response translator completed successfully and produced a response plus usage data.
- Streaming: the translator observed the upstream completion event, usage was available, and the response loop finished without an upstream error or downstream write failure before completion.

An upstream HTTP `2xx` alone is not success because streaming or response translation can still fail. Retries are internal implementation details; only the final successful attempt produces a record. Failure to persist a record is reported through server diagnostics but never changes the already successful proxy response.

### Capture Lifecycle

At route entry, the proxy creates an in-memory pending capture containing:

- request ID and start time;
- public route and client protocol;
- original parsed client request;
- resolved context hints;
- selected model and streaming mode.

The pending capture follows the request through direct-upstream and Codex-account paths. On final semantic completion, the handler supplies:

- translated client response;
- final provider and account entry ID;
- upstream response ID;
- token usage;
- completion time and latency.

The recorder redacts and serializes the completed record, writes it once, and discards the pending capture. Failed or abandoned pending captures are discarded without persistence.

For streaming calls, the client-facing translated chunks are incrementally accumulated into a bounded capture. The persisted body is a normalized semantic representation reconstructed from those translated chunks, not raw SSE framing or duplicated deltas. The existing response stream remains the source of truth; capture must not change chunk ordering or contents.

## Storage Design

Database path: `data/call-records.sqlite`.

SQLite settings:

- WAL journal mode for concurrent reads while calls are written;
- a short busy timeout;
- foreign keys enabled;
- schema version tracked through `PRAGMA user_version`;
- prepared statements for writes and query filters.

### `call_contexts`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Internal UUID |
| `context_key` | TEXT UNIQUE | Stable hash of available grouping identifiers |
| `session_id` | TEXT NULL | Client session/conversation ID |
| `task_id` | TEXT NULL | Explicit task or thread identity |
| `cwd` | TEXT NULL | Client working directory |
| `source` | TEXT NOT NULL | Identity source, such as `proxy_headers`, `claude`, or `responses` |
| `created_at` | TEXT NOT NULL | First observed time |
| `updated_at` | TEXT NOT NULL | Most recent successful call time |

At least one of `session_id`, `task_id`, or `cwd` is required for a context row. Context upsert refreshes `updated_at` without overwriting known values with null fallbacks.

### `call_records`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Internal UUID |
| `request_id` | TEXT NOT NULL UNIQUE | Proxy request identity and idempotency key |
| `context_id` | TEXT NULL | Optional grouping context |
| `started_at` | TEXT NOT NULL | Request start time |
| `completed_at` | TEXT NOT NULL | Semantic completion time |
| `latency_ms` | INTEGER NOT NULL | End-to-end proxy latency |
| `route` | TEXT NOT NULL | Public API route |
| `protocol` | TEXT NOT NULL | `openai`, `anthropic`, `gemini`, `responses`, or `official-agent` |
| `provider` | TEXT NOT NULL | Final upstream provider |
| `account_id` | TEXT NULL | Internal account entry ID, never credential material |
| `model` | TEXT NOT NULL | Client-visible resolved model |
| `upstream_model` | TEXT NULL | Actual upstream model when different |
| `stream` | INTEGER NOT NULL | Boolean streaming flag |
| `response_id` | TEXT NULL | Upstream response identity |
| `input_tokens` | INTEGER NOT NULL | Input tokens |
| `output_tokens` | INTEGER NOT NULL | Output tokens |
| `cached_tokens` | INTEGER NOT NULL | Cached input tokens |
| `reasoning_tokens` | INTEGER NOT NULL | Reasoning tokens |
| `image_input_tokens` | INTEGER NOT NULL | Image-generation input tokens |
| `image_output_tokens` | INTEGER NOT NULL | Image-generation output tokens |
| `request_json` | TEXT NOT NULL | Redacted normalized request JSON |
| `response_json` | TEXT NOT NULL | Redacted normalized response JSON |
| `request_bytes` | INTEGER NOT NULL | Original serialized capture size before truncation |
| `response_bytes` | INTEGER NOT NULL | Original serialized capture size before truncation |
| `request_truncated` | INTEGER NOT NULL | Request capture was bounded |
| `response_truncated` | INTEGER NOT NULL | Response capture was bounded |

Indexes cover `completed_at`, `context_id`, `model`, `provider`, `account_id`, `protocol`, and common compound time filters.

### Full-Text Search

An FTS5 virtual table indexes normalized searchable text extracted from `request_json` and `response_json`. Triggers keep it consistent with `call_records`. If the runtime SQLite build does not support FTS5, startup falls back to escaped `LIKE` search and reports the reduced search mode in store state; call persistence continues.

## Redaction and Bounds

Redaction happens before persistence and reuses the existing recursive redaction foundation with an expanded denylist.

Always redact keys and header names associated with:

- authorization and proxy authorization;
- cookies and set-cookie;
- API keys, access tokens, refresh tokens, session tokens, and JWT values;
- account credentials and OAuth secrets;
- common secret/password fields.

The recorder also redacts bearer-token and API-key-shaped string values when they occur outside known keys. Email-like values are redacted because account identity is already represented by the non-secret internal account entry ID. File contents and natural-language user text are otherwise retained because content retrieval is an explicit MVP requirement.

Request and response captures each have a configurable maximum serialized size, defaulting to 1 MiB. When exceeded, the stored JSON contains a truncation marker and the row records the original byte count. Binary/base64 payloads are replaced with metadata containing media type and byte length. This prevents image payloads and large tool results from dominating disk usage.

## Configuration

A new `call_records` section is added:

```yaml
call_records:
  enabled: false
  retention_days: null
  max_body_bytes: 1048576
```

- `enabled` is off by default because the feature persists user content.
- `retention_days: null` keeps records indefinitely; a positive value deletes older rows during bounded periodic cleanup.
- `max_body_bytes` applies independently to request and response captures.

Dashboard settings expose the enable switch, retention value, and body-size limit with a clear privacy warning. Disabling capture stops new writes but preserves existing records until the user explicitly clears them.

## Admin API

All endpoints are mounted under the existing Dashboard authentication middleware.

### List calls

`GET /admin/call-records`

Filters:

- `from`, `to`
- `context_id`, `session_id`, `task_id`, `cwd`
- `model`, `provider`, `account_id`, `protocol`
- `stream`
- `search`
- `limit`, `offset`
- `sort=completed_at|latency_ms|input_tokens|output_tokens`
- `order=asc|desc`

The list response includes metadata and short request/response previews, not full bodies.

### Get call detail

`GET /admin/call-records/:id`

Returns full row metadata, context metadata, and redacted captured bodies.

### List contexts

`GET /admin/call-contexts`

Returns contexts with call count, first/last call timestamps, and aggregate token totals. It supports the same time and identity filters plus pagination.

### Store state and deletion

- `GET /admin/call-records/state` returns enabled state, database path, row count, database bytes, and search mode.
- `POST /admin/call-records/clear` deletes all contexts and records after the existing authenticated UI confirmation.

No endpoint accepts raw SQL.

## Dashboard

Add `#/call-records` as a first-class Dashboard tab named “Call Records” / “调用记录”.

### Controls

- time range;
- flat calls or grouped contexts view;
- session/task/working-directory filter;
- model, provider, account, protocol, and streaming filters;
- full-text query across redacted request and response text;
- reset filters;
- capture state, row count, and disk-size indicator.

Filtering is server-side, debounced for text input, and resets pagination when any filter changes.

### Flat View

Each row shows:

- completion time;
- session/task or working-directory label;
- model and provider;
- input, cached, reasoning, and output tokens;
- end-to-end latency;
- streaming indicator.

### Grouped View

Each context row shows session/task/working directory, call count, time span, and aggregate token totals. Selecting a context switches to its calls while retaining the broader filters.

### Detail View

The detail panel shows:

- complete metadata;
- formatted redacted request JSON;
- formatted redacted response JSON;
- truncation warnings and original byte sizes;
- copy buttons for each JSON document.

The page does not calculate or display a quality score in this MVP.

## Error Handling

- Schema initialization failures disable call recording and emit a clear server error; proxy traffic remains available.
- Individual write failures are caught and logged with request ID but do not alter the client response.
- Duplicate `request_id` writes are ignored, making finalization idempotent.
- Malformed query filters return `400` with validation details.
- Missing records return `404`.
- FTS5 absence degrades to `LIKE` search rather than disabling storage.
- Retention cleanup runs in bounded batches and does not block proxy startup.

## Testing

### Unit tests

- context identity precedence and stable hashing;
- recursive key/value redaction and base64 replacement;
- bounded request/response serialization;
- SQLite schema initialization and versioning;
- insert idempotency and context upsert behavior;
- every list filter, sort allowlist, pagination, and search fallback;
- retention cleanup and clear behavior;
- stream semantic response accumulator.

### Integration tests

- successful non-streaming Codex call records one row;
- successful streaming Codex call records one row after completion;
- direct OpenAI/Anthropic/Gemini upstream paths record one row;
- failed, retried-only, aborted, prematurely closed, and translation-failed calls record no row;
- final success after retries records only the final call;
- database write failure does not change the proxy response;
- admin endpoints require Dashboard authentication and never expose secrets.

### Web tests

- navigation exposes the new tab;
- filters reset pagination and generate the expected query;
- flat/grouped mode switching;
- empty, loading, error, and populated states;
- detail rendering, truncation warnings, and JSON copy actions;
- Chinese and English labels.

### Verification

Run targeted call-record tests first, followed by root typecheck/tests, web tests, and production builds.

## Delivery Boundaries

Implementation should reuse existing route metadata and completion callbacks rather than parsing console log strings. It should add one recorder boundary shared by Codex-account and direct-upstream handlers, keep current audit logs unchanged, and avoid unrelated refactors.
