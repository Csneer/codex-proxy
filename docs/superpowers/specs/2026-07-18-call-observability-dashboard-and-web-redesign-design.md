# Call Observability Dashboard and Web Redesign

## Status and authority

Status: approved design, awaiting written-spec review.

This document supersedes the UI, full-text indexing, raw-body retention, and call-detail presentation sections of `2026-07-11-successful-call-records-design.md`. The earlier document remains the historical definition of successful-call capture semantics, context identity precedence, authentication boundaries, redaction requirements, and “do not affect the proxy response” behavior unless this document explicitly changes them.

`DESIGN.md` is the canonical product and visual contract. This document is the implementation-facing contract for observability storage, APIs, migration, background persistence, and acceptance tests.

## Problem statement

The current successful-call MVP proves that calls can be captured and retrieved, but its stored and displayed form is not suitable for ongoing operation:

- the detail view pretty-prints the request and response JSON into two large `<pre>` blocks;
- streaming responses retain large event arrays instead of a normalized final answer;
- the FTS index covers complete request and response JSON, including repeated conversation history, tool schemas, and thousands of stream delta events;
- the list API already exposes structured metadata, but the UI uses only a small portion of it;
- the dashboard does not answer the first operational questions: whether new successful calls are arriving, which models and contexts are active, and how quickly storage is growing;
- the rest of the Web UI uses inconsistent page widths, navigation patterns, type sizes, colors, and component treatments.

Read-only inspection of the current local data demonstrated the storage impact:

- roughly 800 successful calls across 21 contexts;
- a main SQLite file around 444 MB, with a WAL observed around 66 MB;
- average serialized request around 638 KiB and response around 141 KiB;
- one 377-call context repeated approximately 342 MB of request history;
- request payloads in that context grew from about 94 KiB to about 1.15 MiB;
- streaming data contained large numbers of `custom_tool_call_input.delta` events and repeated lifecycle snapshots.

The core defect is therefore not JSON formatting. The system needs a durable semantic analysis layer and a temporary raw evidence layer with separate retention and retrieval behavior.

## Goals

1. Make call observability the default entry point for operational review.
2. Show collection recency, successful-call volume, tokens, cache use, model share, storage, and active contexts for Today, 24h, and 7d.
3. Let users drill from dashboard to context timeline to semantic call detail.
4. Search normalized user and assistant content instead of protocol noise.
5. Keep bounded, redacted raw request/response/event evidence for seven days, with explicit truncation metadata, then remove only that raw layer.
6. Keep semantic content and aggregate analysis useful after raw expiry.
7. Count failure, interruption, and retry outcomes without retaining their bodies.
8. Migrate existing data without destructive in-place rewriting before validation.
9. Give the complete Web UI one desktop-first shell, type system, component language, and configurable light/dark transparent theme.
10. Store one custom background and its appearance parameters on the server so other devices see the same environment.

## Non-goals

- retaining failed request/response content;
- per-request quality scoring, cost accounting, or optimization recommendations;
- arbitrary dashboard building;
- a primary custom date-range workflow;
- an exact pixel clone of Claude or the referenced itch.io site;
- mobile account bulk administration;
- geometric refraction, displacement, parallax, animated wallpaper, or image bending;
- adding external observability infrastructure or a new database server.

## Chosen approach

### Alternatives considered

#### Continue storing complete JSON and redesign only the detail component

This is the smallest UI diff, but it preserves the known storage, duplication, stream-event, and search-noise failures. It is rejected.

#### Store semantic columns beside raw JSON in the existing table

This reduces search noise, but a single hot table still mixes permanent analysis data with frequently expired large bodies. Cleanup, vacuuming, backups, and detail reads continue to operate on the same oversized database. It is rejected for long-term storage, though the migration temporarily reads the legacy columns.

#### Use a permanent semantic database plus a seven-day raw evidence database

This is selected. The semantic database remains small, queryable, and stable. The raw database can expire compressed evidence independently and can be recreated without invalidating dashboard history. Semantic persistence is the required success path; raw persistence is best-effort and never changes the proxy response.

## Domain model

### Successful call

The existing definition remains: one call is recorded only after final semantic completion. A 2xx response without completed translation/streaming is not sufficient. Retries do not create successful rows; only the final completed attempt does.

### Context

The existing conservative context resolution remains. A context groups calls by explicit or already-stable session, task, thread, or working-directory identity. Ungrouped calls remain visible and searchable.

The UI derives a display label in this order:

1. explicit task/thread label if present;
2. explicit session/conversation label if present;
3. working-directory basename;
4. shortened context identifier;
5. “Ungrouped calls”.

The derived label is presentation data, not a new grouping identity.

### Semantic projection

A semantic projection is the normalized, versioned representation used by lists, search, context timelines, and the default detail view. Version 1 contains:

- current-turn user/developer input text, with role boundaries retained;
- final assistant output text reconstructed from the completed translated response;
- tool activity descriptors: tool name, success state when known, elapsed time when known, and a bounded human-readable result summary;
- model/protocol/provider, usage, latency, finish reason, message count, tool call count, and event count;
- request/response byte counts and truncation flags from capture;
- a projection status and diagnostic reason if only a partial projection could be produced.

It deliberately excludes from the long-term searchable body:

- repeated conversation history that is already represented by earlier calls in the same context;
- complete tool definitions and JSON schemas;
- authorization, credentials, cookies, emails, and existing redacted values;
- raw SSE framing and incremental delta events;
- base64/binary payloads;
- full tool result bodies when the bounded semantic summary is sufficient.

“Current turn” means the request suffix after the last assistant output. It may include a user message, tool results, and developer instructions that belong to the same turn. When a protocol cannot establish that boundary with confidence, the extractor uses the final user message plus immediately following tool-result items and marks the projection `partial` rather than copying the entire history.

System/developer boilerplate is not copied into every FTS row. Version 1 records a stable SHA-256 fingerprint and an optional bounded preview for diagnostics. It is not part of the default search index.

### Raw evidence

Raw evidence is the redacted and bounded request, translated response, and normalized stream-event capture used for recent diagnosis. It is compressed and stored separately for seven days. Its presence is not required for a semantic record to be valid. “Raw” means protocol-shaped evidence before semantic projection, not byte-for-byte network replay: each request and response part is bounded by `raw_max_body_bytes`, and the UI/API must expose original byte counts plus truncation flags.

The detail API reports one of four raw states:

- `available`: evidence exists and includes its expiry time;
- `expired`: the seven-day deadline has passed;
- `missing`: evidence should still be inside the retention window but the best-effort write failed or was removed;
- `unavailable`: the source record never contained recoverable raw data or migration could not parse it.

## Storage architecture

### Permanent database

Path: existing `data/call-records.sqlite`.

SQLite retains WAL mode, a busy timeout, foreign keys, prepared statements, and `PRAGMA user_version` migrations. The permanent database contains contexts, semantic records, semantic FTS, and outcome buckets.

#### `call_contexts`

Keep the existing identity columns and timestamps. Add no speculative hierarchy. Context metrics are derived from indexed `call_records` rows for the selected range.

#### `call_records`

The upgraded table contains stable metadata and a compact projection summary. Legacy `request_json` and `response_json` remain readable during migration, then are removed only after a validated database-copy migration.

| Column | Type | Contract |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Existing call UUID |
| `request_id` | TEXT UNIQUE NOT NULL | Existing idempotency key |
| `context_id` | TEXT NULL | Existing context reference |
| `started_at`, `completed_at` | TEXT NOT NULL | ISO timestamps |
| `latency_ms` | INTEGER NOT NULL | End-to-end latency |
| `route`, `protocol`, `provider` | TEXT NOT NULL | Stable routing dimensions |
| `account_id` | TEXT NULL | Internal account entry only |
| `model`, `upstream_model` | TEXT / TEXT NULL | Client and upstream model |
| `stream` | INTEGER NOT NULL | Boolean |
| `response_id` | TEXT NULL | Upstream response identity |
| usage columns | INTEGER NOT NULL | Input, output, cached, reasoning, and image tokens |
| `request_bytes`, `response_bytes` | INTEGER NOT NULL | Original captured sizes |
| `request_truncated`, `response_truncated` | INTEGER NOT NULL | Existing bounded-capture flags |
| `semantic_version` | INTEGER NOT NULL | Starts at `1` |
| `projection_status` | TEXT NOT NULL | `complete`, `partial`, or `failed` |
| `projection_reason` | TEXT NULL | Bounded machine-readable diagnostic |
| `request_preview`, `response_preview` | TEXT NOT NULL | Plain-text list previews, maximum 240 Unicode code points |
| `finish_reason` | TEXT NULL | Final semantic finish reason |
| `message_count`, `tool_call_count`, `event_count` | INTEGER NOT NULL | Projection statistics |
| `system_fingerprint` | TEXT NULL | SHA-256 of normalized system/developer content |
| `raw_expires_at` | TEXT NULL | Expected raw expiry; null when unavailable |
| `created_schema_version` | INTEGER NOT NULL | Version that first created this semantic row |

The table does not retain large permanent request or response JSON fields after the copy migration completes.

#### `call_record_content`

One row per successful call holds bounded long-term semantic text:

| Column | Type | Contract |
| --- | --- | --- |
| `call_id` | TEXT PRIMARY KEY | Cascading reference to `call_records` |
| `request_text` | TEXT NOT NULL | Current-turn normalized input, max 256 KiB UTF-8 |
| `response_text` | TEXT NOT NULL | Final assistant output, max 256 KiB UTF-8 |
| `system_preview` | TEXT NOT NULL | Optional bounded diagnostic preview, max 4 KiB |
| `tool_names_json` | TEXT NOT NULL | Deduplicated names only |
| `tool_summary_text` | TEXT NOT NULL | Bounded activity/result summaries, max 64 KiB |
| `request_text_truncated` | INTEGER NOT NULL | Boolean |
| `response_text_truncated` | INTEGER NOT NULL | Boolean |
| `tool_text_truncated` | INTEGER NOT NULL | Boolean |

Bounds are applied after redaction and normalization. Truncation occurs at Unicode boundaries and adds a visible marker. The original byte sizes remain in `call_records`.

#### `call_records_fts`

FTS5 indexes only:

- `request_text`;
- `response_text`;
- `tool_summary_text`;
- a denormalized context display/search label.

It does not index raw JSON, system boilerplate, tool schemas, stream events, model metadata, or IDs. Exact metadata filters use normal indexed columns. CJK-containing search falls back to escaped `LIKE` over semantic columns until a tested tokenizer suitable for the shipped SQLite runtime is available. FTS absence continues to degrade to `LIKE`, and store state reports the mode.

#### `call_outcome_buckets`

This table counts outcomes without storing failed bodies.

| Column | Type | Contract |
| --- | --- | --- |
| `bucket_start` | TEXT NOT NULL | UTC hour boundary |
| `outcome` | TEXT NOT NULL | `success`, `failure`, `interrupted`, or `retry` |
| `protocol` | TEXT NOT NULL | Client protocol |
| `provider` | TEXT NOT NULL | Provider, or `unknown` before selection |
| `model` | TEXT NOT NULL | Client-visible model, or `unknown` |
| `count` | INTEGER NOT NULL | Incremented count |

Primary key: `(bucket_start, outcome, protocol, provider, model)`. Retain buckets for 90 days so the 7-day dashboard remains stable without creating an indefinite secondary telemetry store.

Success increments once when semantic completion finalizes. Each actual upstream retry increments `retry`. Terminal unsuccessful requests increment exactly one of `failure` or `interrupted`; they never create `call_records`, `call_record_content`, or raw rows.

Dashboard success totals and trends use `call_records` as their authoritative source. Success buckets exist only to support bounded outcome-rate comparisons. Migration backfills success buckets for legacy rows inside `outcome_retention_days`; it does not fabricate historical failure, interruption, or retry counts that were never collected.

Outcome collection has one protocol-neutral boundary. Every pending proxy request owns a `CallOutcomeTracker` keyed by `request_id` and a monotonically increasing `attempt_ordinal`. Route/retry/account/session-recovery code must call `beginUpstreamAttempt()` exactly once, immediately before an HTTP request or WebSocket request is actually dispatched. The tracker increments `retry` only when `attempt_ordinal > 1`; higher-level retry decisions never increment counters themselves. Account rotation, stale-session recovery, stripped-state retry, and empty-response retry therefore count only if they dispatch another upstream attempt. Transport reconnects that continue the same upstream response do not count unless they reissue the model request.

Terminal classification is also centralized: a downstream abort or a stream that terminates after response delivery begins is `interrupted`; another terminal unsuccessful request is `failure`; semantic completion is `success`. Only one terminal outcome may be finalized per `request_id`. Provider/model dimensions come from the dispatched attempt, or `unknown` when no attempt began. Nested retry-loop tests must prove that one additional dispatch produces one retry count and that terminal finalization is idempotent.

### Raw evidence database

Path: `data/call-records-raw.sqlite`.

#### `call_raw_evidence`

| Column | Type | Contract |
| --- | --- | --- |
| `call_id` | TEXT PRIMARY KEY | Matches the permanent call ID; no cross-database foreign key |
| `created_at`, `expires_at` | TEXT NOT NULL | Capture and expiry timestamps |
| `codec` | TEXT NOT NULL | `gzip-json-v1` |
| `request_blob` | BLOB NULL | Gzip-compressed redacted request JSON |
| `response_blob` | BLOB NULL | Gzip-compressed redacted response/event JSON |
| `request_compressed_bytes`, `response_compressed_bytes` | INTEGER NOT NULL | Stored sizes |
| `request_sha256`, `response_sha256` | TEXT NULL | Integrity checks for present blobs |

The database uses WAL while active. Cleanup deletes at most 1,000 expired rows per transaction, checkpoints after bounded cleanup, and schedules vacuum only when reclaimable pages cross a configured threshold. Raw cleanup never deletes semantic rows or contexts.

### Write ordering and failure isolation

Finalization performs these steps:

1. normalize, redact, and bound semantic content in memory;
2. commit context, `call_records`, `call_record_content`, semantic FTS maintenance, and the success outcome increment in one permanent-database transaction;
3. after that commit succeeds, compress and insert raw evidence into the raw database;
4. if raw insertion fails, report a diagnostic with `request_id` and leave the semantic call usable with raw state `missing`;
5. if permanent insertion fails, do not write raw evidence and do not change the already successful client response.

Duplicate `request_id` finalization remains idempotent. Outcome increments must be part of the same permanent transaction as first insertion so duplicate finalization cannot double-count success.

## Semantic extraction

### Boundary

Introduce a protocol-neutral `SemanticProjector` interface. Protocol adapters return the same `SemanticProjectionV1`; storage and UI do not inspect protocol JSON.

Inputs:

- the redacted parsed client request;
- the completed translated client response or stream accumulator;
- usage and completion metadata;
- protocol and route.

Outputs:

- the bounded semantic content fields;
- preview and count fields;
- finish reason and projection status;
- raw evidence payloads for optional compression.

### Request extraction rules

- Chat Completions and Anthropic Messages: find the suffix after the last assistant message; retain user/developer/tool-result roles; exclude tool definitions.
- Responses and official-agent requests: retain current input/message/function-result items; use known conversation/thread boundaries rather than parsing prompt prose.
- Gemini: normalize user/model parts and retain the final user/tool-result turn; ignore inline binary data after recording media metadata.
- Unknown items: include a bounded textual representation only when it is clearly user-visible content; otherwise count and omit it.

### Response extraction rules

- Non-streaming: collect final assistant-visible text and tool calls from the translated client response.
- Streaming: the accumulator folds text deltas by stable item/content identifiers, records tool lifecycle once, retains the final usage/finish state, and discards duplicate `created`, `in_progress`, and `completed` snapshots after projection.
- A completed response with no text but valid tool calls is a complete semantic projection.
- If completion is valid but an unfamiliar event prevents full extraction, persist a partial projection plus event counts; do not fall back to indexing the complete raw event array.

## Query and API design

All endpoints remain under existing dashboard authentication. No endpoint accepts SQL or filesystem paths.

### Range semantics

- `today`: local calendar start through now. The browser sends its IANA timezone; the server validates it and converts boundaries to UTC.
- `24h`: rolling 24 hours ending now.
- `7d`: rolling seven days ending now.
- APIs also accept explicit ISO `from` and `to` for internal/secondary custom-range use, bounded to 90 days per request.

### Overview

`GET /admin/call-observability/overview?range=today|24h|7d&timezone=Asia/Shanghai`

Returns one internally consistent snapshot:

- range boundaries and generated-at time;
- successful-call count and previous-period comparison;
- last successful call timestamp;
- token totals and cache ratio;
- permanent database, raw database, semantic-content, FTS, WAL, and total byte estimates;
- growth during the range;
- hourly/daily success series;
- model and protocol/provider distributions;
- failure/interruption/retry counts from outcome buckets;
- top contexts with call count, tokens, bytes, latency, and last success.

Storage values are estimates derived from SQLite page statistics and content/blob byte sums. The response labels the measurement method and must not pretend compressed/raw/logical sizes are interchangeable.

### Contexts

`GET /admin/call-contexts` keeps existing filters and adds:

- range/timezone shortcuts;
- sort by total tokens, logical bytes, latency, and last success;
- aggregate request/response bytes and average/P95 latency;
- primary model and model share.

`GET /admin/call-contexts/:id/summary` returns the selected context metrics and distributions.

`GET /admin/call-contexts/:id/calls` returns its semantic call timeline with server-side pagination. List rows contain previews, metadata, and raw state, never raw blobs.

### Calls and search

`GET /admin/call-records` continues to support metadata filters and pagination, but previews come from semantic fields.

`GET /admin/call-records/search` accepts:

- `q` semantic full-text query;
- range/timezone;
- context, session, task, cwd, model, provider, account, protocol, and streaming filters;
- sort by relevance, completion time, latency, or token totals;
- limit and cursor/offset bounded by server policy.

Search snippets use escaped semantic text with matched terms highlighted by the client; the server never returns HTML from stored content.

### Semantic detail and raw evidence

`GET /admin/call-records/:id` returns metadata, semantic content, projection state, raw availability, and expiry. It does not return raw JSON.

`GET /admin/call-records/:id/raw` is lazy and returns decompressed redacted evidence only when raw state is `available`. It accepts `part=request|response` and enforces a decompressed response limit. Error mapping is explicit: an unknown call returns `404 call_not_found`, expired evidence returns `410 raw_expired`, an expected in-window raw write that is absent returns `409 raw_missing`, and a call that never had recoverable raw evidence returns `404 raw_unavailable`.

The client renders raw request JSON as a collapsible JSON tree and streaming evidence as a compact event timeline with filters. Neither is expanded by default.

### State and deletion

`GET /admin/call-records/state` adds schema versions, projection migration progress, raw retention, last cleanup, raw row count/bytes, and outcome-bucket range.

Deletion operations are explicit:

- clear raw evidence only;
- clear all call observability data;
- rebuild semantic projections/FTS from still-available legacy or raw evidence.

The UI requires an authenticated confirmation that states exactly which layers will be removed.

## Dashboard information architecture

### Level 1: call overview

The call dashboard is the observability landing page. Default range is Today; 24h and 7d are adjacent shortcuts.

Above the fold:

- successful calls;
- last success as relative and absolute time;
- total tokens and cache hit ratio;
- total storage and range growth;
- success trend;
- model share;
- storage composition;
- aggregated failure, interruption, and retry counts with a “bodies are not retained” explanation;
- active context/task ranking.

The overview must distinguish “collection disabled”, “enabled but no calls”, “range has no calls”, “refresh failed with stale data”, and “collection active”.

### Level 2: context view

The context page shows:

- call count and last success;
- input/output/cached tokens;
- raw and semantic logical bytes;
- average and P95 latency;
- model/protocol mix and tool-call count;
- a latest-first semantic timeline.

Selecting a timeline row opens the call detail while retaining the context and range in navigation state.

### Level 3: call detail

Default order:

1. completion status, timestamps, and identifiers;
2. current-turn user/developer content;
3. final assistant output;
4. tool activity summaries;
5. stable metadata and usage;
6. projection/truncation notices;
7. raw retention state and collapsed raw evidence.

The detail view never displays a full request/response dump before semantic content.

### Search

Global search is available from the top bar and keyboard shortcut. It searches semantic content, context labels, model, and call identifiers. Advanced metadata filters appear in a secondary panel, not permanently above the overview.

## Web shell and visual system

### Navigation and layout

- replace page-specific top-tab structures with one high-density icon rail and common top bar;
- use breadcrumbs for context/detail hierarchy on desktop and only the current page label on phones;
- allow dashboard and table pages to use nearly the full workbench width;
- use shared page headers, panels, metric cards, tables, filters, statuses, disclosures, drawers, empty states, and error states across all existing pages.

The redesign preserves existing features and behavior. It does not use visual cleanup as permission to remove account, proxy, API, settings, usage, logging, or error workflows.

### Typography

The approved type scale is intentionally small in count rather than small in pixels:

| Role | Size | Use |
| --- | --- | --- |
| Metadata | 11px | timestamps, secondary labels, captions, table help |
| Control/component | 12px | buttons, filters, table cells, panel titles |
| Reading body | 13px | semantic user/assistant content and explanations |
| Section emphasis | 16px | dialog/drawer titles or a standalone heading that introduces multiple panels; never card/table/control text |
| Page title | 22px | one per screen |
| Primary metric | 26px | metric-card value only |

No operational or interactive text may be below 11px. Metrics use the system sans stack with tabular numerals, not a separate decorative face. The serif identity stack is limited to the product name and page title. Weight, muted color, and spacing establish secondary hierarchy before another size is introduced.

### Theme and glass defaults

Light defaults:

- workbench alpha: 0.38;
- card alpha: 0.49;
- restrained terracotta accent: `#BD6041`;
- background brightness baseline: 0.72 for the approved sample image.

Dark defaults:

- workbench alpha: 0.36;
- card alpha: 0.48;
- accent: `#DF7957`;
- background brightness baseline: 0.52 for the approved sample image.

Shared defaults:

- background blur: 2px, adjustable to 0;
- component backdrop blur: light and bounded, normally 4px;
- no displacement/refraction filter;
- a contrast guard may increase surface opacity beyond the selected value;
- no-background/pure mode always remains available.

### Appearance persistence

The server stores one shared background asset and shared appearance defaults. Each browser stores only its light/dark preference.

Configuration shape:

```yaml
ui:
  background:
    enabled: true
    fit: cover
    position_x: 54
    position_y: 50
  appearance:
    panel_opacity_light: 0.38
    card_opacity_light: 0.49
    panel_opacity_dark: 0.36
    card_opacity_dark: 0.48
    background_brightness_light: 0.72
    background_brightness_dark: 0.52
    background_blur_px: 2
```

The binary image is not embedded in YAML. It is stored under the application data directory with a generated filename; configuration stores only server-owned metadata.

Admin endpoints:

- `GET /admin/ui-appearance` returns settings and background metadata;
- `PATCH /admin/ui-appearance` validates and stores bounded parameters;
- `POST /admin/ui-background` accepts one multipart image and atomically replaces the current asset;
- `GET /admin/ui-background` serves the authenticated cached asset;
- `DELETE /admin/ui-background` removes it and activates pure mode.

Accepted upload types are PNG, JPEG, and WebP. Reject SVG and animated formats. Default limits are 16 MiB and 8192×8192 pixels. Validate magic bytes, decoded header dimensions, and server-owned paths; never trust client filenames or MIME alone. Replacement writes a temporary file, fsyncs, renames atomically, then removes the previous asset.

### Responsive contract

- Desktop ≥1024px: complete navigation, four metrics, split charts, dense tables, complete administration.
- Tablet 768–1023px: two metrics per row, stacked secondary analysis, functional forms and tables.
- Phone <768px: read-oriented dashboard/context/detail, collapsed breadcrumb, stacked detail metadata, horizontal overflow only for secondary wide tables, and no attempt to expose bulk administration.

## Configuration

Evolve the current `call_records` settings to:

```yaml
call_records:
  enabled: false
  raw_retention_days: 7
  semantic_retention_days: null
  semantic_max_text_bytes: 262144
  tool_summary_max_bytes: 65536
  raw_max_body_bytes: 1048576
  outcome_retention_days: 90
```

Compatibility mapping during migration:

- existing `max_body_bytes` becomes `raw_max_body_bytes`;
- existing `retention_days` no longer controls raw evidence. Migration copies its explicit value to `semantic_retention_days` for backward compatibility and warns that this is separate from seven-day raw retention;
- disabled collection stops new semantic and raw writes but preserves existing data until an explicit clear operation.

The settings UI explains privacy and retention. Raw retention defaults to seven days and may be configured from 1 to 30 days. Permanent semantic retention remains unlimited unless the existing operator explicitly configured deletion.

## Migration strategy

Migration is resumable, versioned, and copy-first.

Schema expansion and semantic backfill may run while the proxy is serving traffic. The final compact-file replacement may not. Compaction is an explicit maintenance action that prepares a shadow database online but completes its cutover on a controlled restart before the HTTP server begins listening. This is a short service-availability tradeoff, not a zero-downtime migration; it is chosen so successful-call rows cannot race an atomic rename.

### Phase A: prepare

1. checkpoint the legacy WAL;
2. record legacy row/context counts, token sums, min/max timestamps, and database hashes/paths;
3. create a timestamped backup or copy in the same filesystem with sufficient free-space validation;
4. create the new semantic tables, migration state, outcome buckets, and raw database without dropping legacy fields;
5. place the store in dual-read migration mode: legacy rows remain readable, while new successful calls use the version-2 semantic/raw write path;
6. record the live database schema version and a compaction high-water mark for later validation, but do not swap files while the service is accepting traffic.

### Phase B: backfill projections

Process legacy rows in primary-key batches with a saved cursor:

1. parse the redacted `request_json` and `response_json`;
2. run the same version-1 semantic projector used for new calls;
3. insert/update `call_record_content` and compact summary fields;
4. copy only evidence whose `completed_at` is inside the current seven-day window into compressed raw storage;
5. rebuild recent success outcome buckets inside `outcome_retention_days`, while leaving unobserved legacy non-success outcomes absent;
6. mark parse failures `partial` or `failed` with a bounded reason; keep the source row available for retry;
7. commit each batch and update migration progress.

Backfill is restart-safe and idempotent by `(call_id, semantic_version)`.

### Phase C: validate

The migration cannot advance until all of these match or are explicitly accounted for:

- successful row count and unique request IDs;
- context count and membership;
- total input/output/cached/reasoning tokens;
- first/last completion timestamps;
- every row has a projection status;
- sampled semantic outputs match the final assistant text rather than raw event arrays;
- FTS row count equals the number of searchable semantic rows;
- raw rows are limited to the configured retention window;
- API list/detail/context results are equivalent for stable metadata.

Produce a migration report with complete/partial/failed counts and before/after logical and physical sizes.

### Phase D: prepare and cut over the compact database

Do not drop large legacy columns in place. While the service is live, a background job may build a shadow permanent SQLite file containing only the approved schema and record its source high-water mark. It must not rename files or change the active store.

Final cutover runs only during an explicit controlled restart, before `serve()` begins listening:

1. open the live database as the sole writer and checkpoint its WAL;
2. copy/replay every row after the shadow high-water mark into the shadow file, including content, contexts, outcome buckets, and migration state;
3. compare row/request-ID counts, context membership, token sums, first/last timestamps, maximum live row sequence, and FTS/searchable-row counts;
4. run `PRAGMA integrity_check` on both files;
5. close every live and shadow SQLite connection;
6. atomically rename the live file to the timestamped rollback name and the shadow file to the canonical path, with directory fsync where supported;
7. reopen the canonical store, verify schema/version/counts again, and only then allow the HTTP server to listen;
8. on any failure, restore/open the rollback file and start without performing the swap.

Because no proxy traffic is accepted during these steps, no completed call can be written between final delta replay and rename. The operator-visible maintenance state reports progress and failure. The legacy rollback file remains until an explicit later removal. This avoids relying on `VACUUM` or an unsafe live rename to make the transformation recoverable.

### Phase E: background maintenance

After activation:

- bounded raw cleanup runs periodically and at startup without blocking proxy readiness;
- semantic backfill/reprojection can resume in the background;
- FTS rebuild is explicit and reports progress;
- old backup removal is a separate confirmed operation, not automatic during first startup.

## Error handling and degraded modes

- Proxy traffic is the primary workload. Observability initialization, projection, write, cleanup, or UI failures never change a completed client response.
- Permanent database unavailable: disable new call persistence, surface a clear dashboard/server diagnostic, keep proxy traffic active.
- Projector partial: store stable metadata and the content that was safely extracted; label the detail and exclude empty/failed fields from FTS.
- Raw database unavailable or full: keep semantic records, mark raw `missing`, emit rate-limited diagnostics, and retry later only for safe maintenance—not by replaying client requests.
- FTS unavailable: use escaped semantic `LIKE` search and report degraded search mode.
- Overview subquery failure: return partial sections with per-section errors and generated-at time; the UI keeps successful panels visible.
- Background invalid/missing: fall back to pure mode without blocking dashboard access.
- Background upload failure: keep the previous asset and settings unchanged.
- Network/refresh failure: retain stale UI data with its timestamp and a retry action.
- Expired raw request: return a distinct expiry response and keep semantic detail visible.

## Security and privacy

- Existing recursive secret and value-shape redaction runs before both semantic and raw persistence.
- Semantic extraction never reintroduces original unredacted objects after redaction.
- Failed bodies are never stored; only dimensional outcome counts are retained.
- Admin endpoints use existing dashboard authentication. Binding to `0.0.0.0` does not bypass remote authentication.
- Raw retrieval is lazy, authenticated, size-bounded, and never included in overview/list payloads.
- HTML rendering treats all stored text as text, never trusted markup.
- Background uploads reject active content and path traversal, use generated filenames, and remain inside the server-owned data directory.
- Dashboard authentication and CORS are not sufficient CSRF protection. Add one shared admin-mutation guard for every non-`GET`/`HEAD`/`OPTIONS` admin route, including existing settings/clear routes and new rebuild/upload/delete routes. Browser requests must present both an exact same-origin `Origin` value and an `X-Codex-Proxy-CSRF` token obtained from an authenticated `GET /admin/csrf`; the token is random, process/session-bound, time-limited, and compared in constant time. The Web client sends it on every mutation. Non-browser API clients using an explicit `Authorization: Bearer` header and no dashboard Cookie may use the bearer-auth path because the credential is non-ambient. Missing/mismatched Origin or token returns `403`. Loopback dashboard bypass does not bypass this mutation guard. Dashboard cookies use `SameSite=Strict` where compatible. Tests cover hostile cross-origin form/fetch attempts, missing Origin/token, loopback access, cookie sessions, bearer clients, and token expiry.
- Logs report call/request identifiers and error categories but not captured bodies.

## Testing strategy

### Semantic projector unit tests

- current-turn extraction for every supported protocol;
- repeated history is excluded;
- system/developer content is fingerprinted and bounded;
- text/tool deltas fold into one final output/activity entry;
- repeated lifecycle snapshots are counted but not duplicated in semantic text;
- tool-only completions;
- base64/media replacement;
- unknown events produce partial rather than raw-index fallback;
- redaction and Unicode-safe bounds.

### Storage unit tests

- schema version upgrades and rollback behavior;
- permanent transaction idempotency and outcome-count idempotency;
- raw write after semantic commit and independent raw failure;
- gzip integrity hashes and decompression bounds;
- raw retention cleanup batches and permanent-record preservation;
- semantic FTS triggers/rebuild and CJK/FTS fallback;
- context aggregates, storage estimates, and outcome buckets;
- configured semantic retention compatibility.

### Migration tests

- fixture copied from legacy schema version 1;
- resumable batch cursor after interruption;
- valid streaming event array projects to final output;
- malformed legacy body becomes partial/failed without row loss;
- only recent legacy rows enter raw storage;
- validation catches token/context/count mismatch;
- copy-swap preserves a rollback file and passes `PRAGMA integrity_check`.

### API integration tests

- authenticated overview for Today/24h/7d and timezone boundaries;
- context summary/timeline pagination and filters;
- semantic search and safe snippets;
- semantic detail excludes raw blobs;
- raw available/expired/missing/unavailable responses;
- failed, interrupted, and retry paths increment buckets without body rows;
- nested retry/account/session-recovery paths count actual upstream dispatches exactly once;
- clear/rebuild operations and error contracts;
- the shared admin-mutation guard rejects cross-origin and tokenless mutations for both existing and new routes while preserving explicit bearer clients;
- background upload validation, atomic replacement, authenticated serving, and deletion.

### Web tests

- overview loading/empty/disabled/stale/error/healthy states;
- time range updates every dashboard panel consistently;
- overview → context → call navigation retains state;
- semantic detail, truncation notices, raw disclosure, and expiry messaging;
- global search keyboard and filters;
- shared navigation labels, focus return, and active states;
- light/dark browser-local preference and server-shared appearance data;
- opacity/brightness/blur bounds, pure mode, and contrast clamp;
- typography roles use the 11/12/13/16/22/26 scale without page-specific smaller overrides, and 16px appears only on the two permitted heading roles;
- Chinese and English content.

### Verification sequence

1. projector and store unit tests;
2. migration fixtures and integrity checks;
3. call route integration tests, including streaming and retry outcomes;
4. admin API tests;
5. Web component/page tests;
6. root and Web typecheck/lint where configured;
7. `npm run build:web` and `npm run build`;
8. authenticated local smoke test through the bound service;
9. 1440×1050 light/dark screenshots for overview, context, and detail;
10. 390×844 read-only phone overview/detail screenshots;
11. visual-verdict score at least 90 and no known console errors.

## Delivery sequence

Implementation should remain reviewable and reversible:

1. lock current successful-call and migration behavior with fixtures;
2. add semantic projection, permanent schema, outcome buckets, and raw database behind existing collection enablement;
3. backfill and validate without deleting legacy fields;
4. add overview/context/search/detail APIs;
5. build the shared shell, tokens, theme/background settings, and observability pages;
6. migrate existing pages to shared components without changing their business behavior;
7. prepare the shadow copy only after migration acceptance checks pass, then execute final delta replay and copy-swap during the controlled pre-listen maintenance restart;
8. retain rollback data until the operator confirms removal.

Each phase must pass its targeted tests before the next phase depends on it. No phase may require a destructive database operation to demonstrate progress.

## Acceptance criteria

- The default observability screen is the call dashboard with Today, 24h, and 7d ranges.
- The dashboard shows success recency/count, tokens/cache, storage/growth, success trend, model share, storage composition, non-success counts, and active contexts.
- The latest successful call can be reached through context and call drill-down without using search.
- Call detail defaults to current-turn input, final assistant output, tool summary, and stable metadata.
- Bounded redacted raw JSON/events are lazy, collapsed, authenticated, and available for seven days by default; original sizes and truncation are visible and replay completeness is not implied.
- Expiring raw evidence never removes semantic records or semantic searchability.
- Failures, interruptions, and retries contribute only aggregated counts and never body rows.
- FTS does not index full raw JSON, repeated history, tool schemas, or stream delta arrays.
- Migration is resumable, produces a validation report, and preserves a rollback copy; final compact-file cutover occurs before the service listens, with final delta replay and closed connections preventing concurrent-write loss.
- The Web UI uses the shared icon rail, transparent workbench, terracotta accent, light/dark themes, and server-shared background configuration.
- Default glass values match `DESIGN.md`, blur can reach zero, and no geometric refraction is present.
- No operational/interactive text is smaller than 11px; semantic reading text is 13px; page titles and primary metrics use the approved fixed scale.
- Desktop contains the full experience; tablet is functional; phone dashboard/context/detail remain readable.
- Targeted tests, production builds, authenticated smoke checks, and visual-verdict ≥90 pass before completion is claimed.

## Resolved decisions

- Desktop is the primary platform; phone is read-priority.
- Semantic content is permanent unless an existing explicit semantic-retention setting says otherwise.
- Raw evidence defaults to seven-day retention in a separate compressed SQLite database.
- Failed bodies are not retained; non-success outcomes are counted only.
- Today is the default range, with 24h and 7d shortcuts.
- One background and appearance configuration is shared by the server; theme preference is browser-local.
- Light clear glass and dark smoked glass use the same image.
- Panel opacity, background brightness, and blur are adjustable; blur may be zero.
- Refraction, ripple, displacement, and background bending are excluded.
- Typography uses a fixed 11/12/13/16/22/26 scale; 16px is limited to dialog/drawer titles and standalone headings that introduce multiple panels.
- The approved visual baseline is the interactive companion at `http://localhost:52475` and the artifacts cited by `DESIGN.md`.
