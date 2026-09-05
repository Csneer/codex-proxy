# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-09-05
- Primary product surfaces: authenticated Web dashboard, call observability dashboard, context timeline, call detail, account and proxy administration, backup-resource administration, settings, logs, usage, and errors.
- Evidence reviewed:
  - `web/src/App.tsx`
  - `web/src/index.css`
  - `web/src/pages/CallRecordsPage.tsx`
  - `web/src/pages/UsageStats.tsx`
  - `web/src/pages/BackupResourcesPage.tsx`
  - `src/routes/admin/backup-resources.ts`
  - `src/backup-resources/totp.ts`
  - `web/src/components/Header.tsx`
  - `shared/theme/context.tsx`
  - `src/call-records/types.ts`
  - `src/call-records/store.ts`
  - `src/routes/admin/call-records.ts`
  - `docs/superpowers/specs/2026-07-11-successful-call-records-design.md`
  - `.superpowers/brainstorm/1004237-1784314377/content/observability-drilldown-desktop.html`
  - `.superpowers/brainstorm/1004237-1784314377/artifacts/observability-type-overview-light.png`
  - `.superpowers/brainstorm/1004237-1784314377/artifacts/observability-type-context-light.png`
  - `.superpowers/brainstorm/1004237-1784314377/artifacts/observability-type-detail-dark.png`
  - User-provided background reference at `/mnt/c/Users/devop/Pictures/IMG_20260307_152804.png`
- Detailed feature contract: `docs/superpowers/specs/2026-07-18-call-observability-dashboard-and-web-redesign-design.md`.
- Decision rule: this file governs durable product and visual decisions. The detailed feature contract governs call-observability storage, APIs, migration, and acceptance criteria. If they conflict, update both documents before implementation proceeds.

## Brand

- Personality: calm, precise, private, engineer-owned, and quietly warm. The product is an operational workbench rather than a marketing site.
- Trust signals: current collection state, exact timestamps, explicit data-retention labels, stable status colors, predictable navigation, and visible distinctions between stored semantic content and temporary raw evidence.
- Avoid:
  - saturated brand colors over large surfaces;
  - decorative gradients that compete with data;
  - heavy glass refraction, lens distortion, ripples, or warped background imagery;
  - oversized editorial typography;
  - raw JSON as the primary reading experience;
  - ambiguous health indicators that hide the underlying timestamp or count.

## Product goals

- Goals:
  - make the latest successful model activity and collection health understandable at a glance;
  - expose model share, tokens, cache use, storage size, growth, and active contexts without opening individual records;
  - let users drill from the dashboard into a context timeline and then a semantic call detail;
  - keep recent raw evidence for diagnosis without allowing repeated request history and stream deltas to dominate long-term storage or search;
  - give all dashboard pages one navigation, layout, theme, typography, table, filter, and state language;
  - support a server-shared custom background while preserving readable light and dark themes.
- Non-goals:
  - quality scoring, prompt grading, cost forecasting, or automatic optimization advice;
  - retaining failed request or response bodies;
  - a mobile-first administration experience;
  - visible geometric glass refraction or animated background effects;
  - a generic analytics builder or arbitrary custom time-range workflow in the primary UI.
- Success signals:
  - a user can identify whether a recent successful call exists, and when it occurred, without opening a list;
  - a user can identify the most active model and context within one screen;
  - a user can reach a readable user-input/final-output view in two drill-down actions;
  - full-text results are based on semantic content instead of tool schemas, repeated history, or stream delta noise;
  - raw storage converges under a seven-day retention policy while semantic records remain available;
  - all operational text follows the documented type scale and remains readable over the configured background.

## Personas and jobs

- Primary personas:
  - the operator running Codex Proxy on a workstation or private server;
  - a developer diagnosing a session, model, proxy, or translation problem;
  - a power user reviewing personal model usage and storage growth from another desktop device.
- User jobs:
  - verify that the proxy is still receiving and completing calls;
  - understand which models, sessions, and tasks consume the most tokens and storage;
  - search for a remembered user request or assistant answer;
  - inspect a single call without reading protocol envelopes;
  - expand recent raw evidence only when semantic content is insufficient;
  - administer accounts, routes, settings, and logs through the same visual shell.
- Key contexts of use: desktop browsers are primary; tablets receive a functional adaptation; phones support read-oriented dashboard, context, and detail access.

## Information architecture

- Primary navigation: a persistent high-density icon rail with tooltips and an active-state label available to assistive technology. The call dashboard is the default observability destination.
- Core routes/screens:
  - call overview: collection health, range metrics, trends, model share, storage composition, outcome counts, and active contexts;
  - context index and context detail: aggregated usage plus chronological call timeline;
  - call search: global semantic search with advanced filters in a secondary surface;
  - call detail: semantic conversation first, raw evidence second;
  - accounts, proxy routing, usage, logs/errors, API/configuration, and appearance settings.
  - backup resources: manually maintained spare account credentials and SMS numbers managed in one dedicated screen under the account navigation group.
- Content hierarchy:
  1. health and recency;
  2. scale and trend;
  3. active contexts and model distribution;
  4. search and advanced filters;
  5. individual semantic content;
  6. raw protocol evidence.
- Time-range contract: default to local-calendar “Today”; provide “24h” and “7d” shortcuts; keep custom range behind a secondary action rather than in the primary segmented control.

## Design principles

- Background is atmosphere, not content. Every data surface must remain readable when the custom image contains a bright face, dark clothing, or high-contrast highlights.
- Semantic first, evidence on demand. Default views use normalized meaning and stable metadata; raw protocol material is collapsed and retention-labelled.
- Dense but not miniature. Preserve desktop information density through alignment, spacing, and grouping, never by shrinking operational text below 11px.
- Health must be inspectable. Pair “active” or “normal” labels with the last successful timestamp and relevant counts.
- One visual grammar. Existing pages adopt the same shell and tokens instead of creating isolated redesigns.
- Tradeoffs:
  - desktop scan speed takes priority over large touch targets and card-heavy mobile composition;
  - a visible background is allowed, but minimum contrast protection overrides a user-selected transparency value;
  - long-term semantic usefulness takes priority over indefinite raw replay capability.

## Visual language

- Color:
  - light mode uses warm off-white glass, charcoal text, and restrained terracotta accent `#BD6041`;
  - dark mode uses smoked near-black glass, warm off-white text, and lighter terracotta `#DF7957`;
  - green is reserved for successful/healthy state, amber for warning/retention attention, and red for failure/destructive state;
  - charts use a small stable palette and must not use color as the only series identifier.
- Typography:
  - operational stack: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  - technical stack: `ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace`;
  - identity stack, used only for the product name and page title: `ui-serif, "Iowan Old Style", "Noto Serif SC", "Songti SC", serif`;
  - fixed scale: 11px metadata and captions, 12px controls and component titles, 13px reading body, 16px only for dialog/drawer titles or a standalone heading that introduces multiple panels, 22px page title, and 26px primary metric;
  - no operational or interactive text below 11px;
  - tabular numerals are required for metrics, timestamps, token counts, byte sizes, and latency;
  - hierarchy should come from weight, color, and spacing before adding another font size.
- Spacing/layout rhythm: 4px base; use 8, 12, 16, 20, and 24px for most gaps. Desktop content fills the available workbench rather than using the old narrow 960px page.
- Shape/radius/elevation: 9px controls, 12px cards, 18px outer workbench, thin translucent borders, and low-spread shadows. Avoid inflated pill cards; pills are for status and compact filters.
- Motion: 150–220ms color/opacity/transform transitions; no bounce; no background parallax; honor reduced motion.
- Imagery/iconography: one server-shared background image may cover the viewport. Navigation and actions use one consistent outline icon set or repo-native SVGs, never mixed Unicode symbols in production.

## Components

- Existing components to reuse:
  - Preact application and hash-routing structure;
  - current authenticated admin fetch patterns;
  - theme provider behavior and existing account, settings, table, and chart business logic where behavior is correct;
  - existing i18n provider and translation catalog.
- New/changed components:
  - `AppShell`, `IconRail`, `TopBar`, `PageHeader`, `TimeRangeControl`;
  - `MetricCard`, `StatusBadge`, `DataPanel`, `DataTable`, `EmptyState`, `InlineAlert`, and `Skeleton`;
  - `CallOverview`, `ContextTable`, `ContextTimeline`, `SemanticCallDetail`, `RawEvidenceDisclosure`, and `CallSearchDialog`;
  - `AppearanceDrawer`, `BackgroundUploader`, and `GlassSurface` primitives.
  - `BackupTotpCodeModal` for short-lived, on-demand verification-code display from an account detail surface.
- Variants and states:
  - surfaces: workbench, chrome, card, inset, modal/drawer;
  - status: healthy, warning, failed, inactive, unknown;
  - raw evidence: available with expiry, expired, missing because capture failed, and unavailable for migrated/truncated records;
  - tables: loading, empty, error, partial-data warning, selected row, and pagination.
- Token/component ownership:
  - semantic color, typography, opacity, blur, radius, spacing, and shadow tokens live in global CSS variables;
  - components consume semantic tokens and must not embed page-specific light/dark color literals;
  - user appearance settings override bounded CSS custom properties at the shell, not individual component classes.

## Accessibility

- Target standard: WCAG 2.2 AA for authenticated dashboard workflows.
- Keyboard/focus behavior: visible focus rings, logical tab order, keyboard-operable disclosures, tables, segmented controls, dialogs, drawers, and navigation; `Escape` closes transient surfaces and returns focus to the trigger.
- Contrast/readability:
  - minimum contrast protection clamps glass opacity when the configured background would make text fail contrast;
  - status never relies on color alone;
  - body text remains at least 13px and operational metadata at least 11px;
  - pure/no-background mode is always available.
- Screen-reader semantics: landmarks for navigation/header/main, real headings, table semantics, button labels for icon-only controls, live regions for refresh and save outcomes, and explicit descriptions for raw-retention state.
- Reduced motion and sensory considerations: disable nonessential transitions under `prefers-reduced-motion`; do not animate or distort the background; respect `prefers-reduced-transparency` when supported by increasing surface opacity and disabling backdrop blur.

## Responsive behavior

- Supported breakpoints/devices:
  - desktop at 1024px and above is the full operational target;
  - tablet from 768px to 1023px stacks secondary charts and preserves core controls;
  - phone below 768px is a read-priority adaptation.
- Layout adaptations:
  - desktop keeps the icon rail, four-metric row, split dashboards, and aligned data tables;
  - tablet uses two-column metrics and stacks the main/secondary analysis panels;
  - phone hides the rail, collapses breadcrumbs to the current page, uses two metric columns when space permits, stacks context/detail panels, and permits horizontal scrolling for nonessential wide tables;
  - phone does not expose account bulk operations or attempt to compress all desktop columns.
- Touch/hover differences: tooltips must not be the only source of a label; touch targets reach at least 40px on tablet/phone even though desktop controls remain compact.

## Interaction states

- Loading: preserve panel geometry with skeletons; refresh should keep stale data visible and mark it as refreshing.
- Empty: explain whether no calls exist, collection is disabled, or the selected range/filter has no results; provide the relevant action.
- Error: keep other panels usable, identify the failed data source, and provide retry. A raw-evidence error must not hide semantic content. TOTP generation errors must not expose the stored secret.
- Success: show saved/updated confirmation without blocking navigation. Collection health is derived from timestamps and counts, not a decorative animation.
- Disabled: explain why collection, background upload, or an action is unavailable.
- Offline/slow network: keep the last successfully loaded dashboard visible, mark its age, and retry only safe idempotent reads automatically.

## Content voice

- Tone: concise, factual, calm, and operational.
- Terminology:
  - “successful call” means semantic completion, not merely upstream HTTP 2xx;
  - “context” is the shared technical grouping; the UI may label it “session / task” when that is clearer;
  - “semantic content” means normalized current-turn input, final assistant output, and tool activity summary;
  - “raw evidence” means the temporary redacted request/response/event capture;
  - “data size” must identify whether it is raw, semantic, index, or total storage.
- Microcopy rules: show absolute timestamps with relative time where space allows; state retention deadlines explicitly; avoid claiming “normal” without a supporting last-success time.

## Implementation constraints

- Framework/styling system: Preact, TypeScript, Vite, Tailwind 3, and repo-native CSS variables. Do not add a component framework or chart dependency solely for this redesign.
- Design-token constraints: replace the obsolete emerald/no-glass design contract with the semantic tokens in this file. Keep opacity values bounded and theme-specific.
- Performance constraints:
  - custom background assets are served with cache validation and never embedded in configuration JSON;
  - defer raw body download until the disclosure is opened;
  - virtualize or paginate long call/context tables;
  - avoid applying multiple nested high-radius backdrop filters; default background blur is 2px and may be set to 0.
- Compatibility constraints:
  - the same server background configuration is shared by all dashboard devices;
  - light/dark preference remains browser-local;
  - no-background mode works if upload is absent, invalid, deleted, or unsupported;
  - network-exposed dashboard access remains behind existing dashboard authentication.
  - every state-changing admin route is covered by the explicit mutation/CSRF guard defined in the detailed feature contract; CORS and dashboard authentication alone are not treated as CSRF protection.
- Test/screenshot expectations:
  - component tests cover semantic states and keyboard behavior;
  - integration tests cover storage/API contracts;
  - production build and typecheck must pass;
  - visual checks include 1440×1050 light/dark desktop overview and detail plus 390×844 read-only mobile overview/detail;
  - visual-verdict target is at least 90.

## Open questions

- None for the approved scope. New product or visual decisions must be recorded here before implementation diverges from this contract.

## Account text import

- Account management offers a visible “Paste text / 文本导入” action alongside file import. It opens a native modal dialog with a labelled, resizable, scrolling multiline credential input.
- Text uses the existing authenticated account import path and format detection: account JSON, compatible export JSON, JSON lines, and token lines. Preserve the complete input without a frontend length limit; long credentials wrap within the input rather than expanding the dialog.
- Empty input cannot submit; pending imports prevent repeated submissions and dismissal. Results remain visible inside the dialog, including partial failures. Keep input after errors for correction; clear it after complete success or dismissal, and restore focus to the trigger. Credential drafts are never stored in browser persistence.

## Quota-batch account selection

- Goal: use enabled, eligible accounts' actual quota windows in approximate batches, not equal requests and not indefinite account stickiness. This contract supersedes the secondary-first, relative-delta rotation in the 2026-07-21 quota-aware design.
- Reuse the existing selection panel and integer `quota_batch_percent` setting (1–100, existing default 30). Label it as an absolute quota bucket size; a 10-point setting means 0–10%, 10–20%, etc. An account selected at 37% rotates on an observed 40% or higher, not at 47%. The last partial bucket ends at 100%.
- Observe the actual published quota window for each account; do not hardcode window durations or infer them from plan names. When multiple applicable windows are published, use the shortest valid window as the account's batching meter; for a model-specific bucket, prefer that bucket for the matching request. A meter crossing its next bucket triggers one handoff. Unrelated model/review quotas must not drive rotation.
- Keep consecutive requests on the current account within a bucket. Advance to the next eligible account in stable registry order on a boundary or loss of eligibility, preserving existing model, tier, exclusion, cooldown, quota, and concurrency filters. In-flight requests finish on their original accounts; cached/rounded usage can overshoot a boundary.
- Reset/reduced usage, changed official window duration, new/missing meters, and setting changes rebuild the affected boundary without using request counts. No fixed 100-request fallback.
- If no usable recent quota signal exists, temporarily rotate through eligible accounts so missing telemetry cannot cause indefinite stickiness. Recent means within twice the configured quota-refresh interval (minimum one minute). Return to quota batching automatically when data resumes. No extra upstream probe is sent by account selection.
- Store only account IDs and window/bucket metadata in the checkpoint, atomically and owner-readable. Migrate v1/v2 checkpoints without jumping back to the first account. Rotation is process-local; a shared checkpoint is restart recovery, not distributed coordination.
- Web copy must explain dynamic windows, one absolute-boundary example, approximate handoff, and the missing/stale-data fallback. Verify mixed window durations, partial updates, resets, overshoot, held concurrent slots, old checkpoint migration, and real file-backed restore.

## Backup resources feature contract

- Route and navigation: `#/backup-resources` is a dedicated workbench page with its own rail destination, while the account-group secondary navigation also links management accounts, backup resources, and API keys. The page has local tabs for backup accounts and SMS numbers.
- Intended use: centralized management of manually maintained spare OAI-related accounts and reusable SMS numbers. This is an operational convenience surface, not a production secrets-management product.
- Backup account fields: email, manually maintained account status, email password, ChatGPT password, TOTP secret, email-code URL, note, created time, and updated time. Account status is exactly `plus`, `free`, `unregistered`, or `pro`; it is descriptive metadata and never drives routing or automatic account checks.
- SMS fields: phone number, non-negative use count, note, created time, and updated time. A dedicated “use once” action increments the count atomically; manual edits may correct the count.
- Default disclosure: account lists expose email, manually maintained account status, notes, timestamps, and factual `has*` flags only. Passwords, TOTP secrets, and full email-code URLs remain hidden until a single-record detail request. From that detail surface, an account with a stored TOTP may open a higher-layer modal that shows the current code, countdown, and explicit copy action. The code is generated on demand, is not persisted, and is not placed in a URL or log. SMS numbers may be shown in full inside this authenticated personal dashboard and masked in compact list presentation.
- Edit behavior: existing secrets are never preloaded merely to render an edit form. Omitted secret fields remain unchanged; explicit replacement updates them and explicit removal clears them.
- Storage: backup resources use a dedicated SQLite database and are excluded from existing account import/export. Email, account status, phone number, notes, counts, and timestamps may remain plaintext for simple lookup. Email password, ChatGPT password, TOTP secret, and email-code URL use versioned AES-256-GCM application-layer encryption. Existing databases add `account_status` automatically; legacy rows and create requests that omit status default to `unregistered`.
- Key handling: `CODEX_PROXY_BACKUP_KEY` supplies a base64-encoded 32-byte key when configured. Otherwise the server creates a local base64 key file with owner-only permissions. Missing or invalid keys and authentication failures fail closed and never overwrite ciphertext.
- Security boundary: management authentication and the existing mutation/CSRF guard remain mandatory. Sensitive responses use `Cache-Control: no-store`; secrets never enter URLs, browser persistence, logs, error copy, or existing account exports.
- Explicit non-goals: external KMS/HSM integration, per-record envelope keys, key-rotation UI, step-up authentication, detailed access auditing, automatic inbox access, credential validity probing, bulk reveal/copy, plaintext export, and exposing a TOTP code in the account list.
- Responsive behavior: desktop uses compact tables with visible account-status badges; phone uses stacked cards and 40px actions. Loading, empty, error, save, copy, and delete states follow the shared workbench language. Detail values expose explicit per-value copy actions without introducing bulk secret disclosure.
- Verification: tests cover ciphertext round trips and tamper failure, RFC 6238 TOTP vectors, TOTP route errors and `no-store` responses, legacy status migration, status validation and manual updates, absence of credential plaintext in SQLite/list responses, CRUD and atomic use-count increments, CSRF-compatible mutations, secret-preserving partial updates, Web interaction states, typecheck, and production build.
