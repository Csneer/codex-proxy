# Call Observability Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw call-record list as the default observability experience with a Today/24h/7d dashboard, context drill-down, semantic call detail, global search, and lazy raw evidence.

**Architecture:** Add a read-only analytics boundary over the permanent semantic store and outcome buckets, then expose range-consistent admin endpoints. The Preact client uses one typed hook per screen, hash routes for overview/context/call/search, and the shared shell/components from the Web-shell plan. Raw evidence is fetched only after an authenticated disclosure action.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Preact, SVG/CSS charts, Tailwind/CSS variables, Vitest, Testing Library.

**Prerequisites:** The data-foundation plan must be complete. The Web-shell/theme plan must provide `AppShell`, `PageHeader`, `MetricCard`, `DataPanel`, `DataTable`, `StatusBadge`, `TimeRangeControl`, `Skeleton`, `InlineAlert`, and appearance tokens. Execute in a dedicated worktree; do not begin final compact-file cutover here.

---

## File structure

- Create `src/call-records/analytics.ts`: range parsing and read-only overview/context/search aggregates.
- Create `src/routes/admin/call-observability.ts`: overview and context endpoints.
- Modify `src/routes/admin/call-records.ts`: semantic list/detail/search/raw/state operations only.
- Create `shared/hooks/use-call-observability.ts`: overview/context/detail/search request state with stale-data behavior and abort protection.
- Create `web/src/pages/CallDashboardPage.tsx`: level-one dashboard composition.
- Create `web/src/pages/CallContextPage.tsx`: level-two context summary and timeline.
- Replace `web/src/pages/CallRecordsPage.tsx` with `CallDetailPage` and focused call components, or rename it after route tests are green.
- Create `web/src/components/call-observability/*`: charts, context table, semantic messages, raw disclosure, and search dialog.
- Modify `web/src/App.tsx`: observability becomes the default route; accounts remain one icon-rail destination.
- Modify `shared/i18n/translations.ts`: exact English/Chinese copy.

### Task 1: Define range parsing and the overview response contract

**Files:**
- Create: `src/call-records/analytics.ts`
- Create: `tests/unit/call-records/analytics.test.ts`
- Modify: `src/call-records/types.ts`
- Modify: `src/call-records/store.ts`

- [ ] **Step 1: Write failing timezone and snapshot tests**

```ts
it("resolves Today using the supplied IANA timezone", () => {
  expect(resolveCallRange({ range: "today", timezone: "Asia/Shanghai", now: NOW })).toEqual({
    from: "2026-07-17T16:00:00.000Z",
    to: "2026-07-18T04:00:00.000Z",
    previousFrom: "2026-07-16T16:00:00.000Z",
    previousTo: "2026-07-17T04:00:00.000Z",
  });
});

it("returns one internally consistent overview snapshot", () => {
  const result = analytics.getOverview({ range: RANGE });
  expect(result).toMatchObject({
    success: { count: 2, lastCompletedAt: "2026-07-18T03:55:00.000Z" },
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 80 },
    outcomes: { failure: 1, interrupted: 0, retry: 2 },
  });
  expect(result.generatedAt).toBe(NOW.toISOString());
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/unit/call-records/analytics.test.ts`

Expected: FAIL because `resolveCallRange()` and `CallRecordAnalytics` do not exist.

- [ ] **Step 3: Add exact response types**

```ts
export type CallRangePreset = "today" | "24h" | "7d";
export interface CallOverview {
  range: { preset: CallRangePreset; timezone: string; from: string; to: string };
  generatedAt: string;
  success: { count: number; previousCount: number; lastCompletedAt: string | null };
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheRatio: number };
  storage: {
    permanentBytes: number; rawBytes: number; semanticLogicalBytes: number;
    rawLogicalBytes: number; indexBytes: number; walBytes: number; totalBytes: number;
    rangeGrowthBytes: number; measurement: "sqlite-pages-and-logical-sums";
  };
  outcomes: { failure: number; interrupted: number; retry: number };
  series: Array<{ bucketStart: string; success: number }>;
  models: Array<{ model: string; count: number; share: number }>;
  protocols: Array<{ protocol: string; count: number; share: number }>;
  contexts: CallContextSummary[];
  sections: Record<string, { error?: string }>;
}
```

- [ ] **Step 4: Implement validated ranges and aggregate queries**

Validate timezone with `Intl.DateTimeFormat(..., { timeZone })`; reject invalid names. Use local date parts to find the UTC boundary and rolling milliseconds for 24h/7d. `CallRecordAnalytics.getOverview()` runs all aggregate statements inside one read transaction, uses `call_records` for success, and uses `call_outcome_buckets` only for failure/interrupted/retry.

Storage measurement must return separate physical/logical categories; use SQLite `page_count * page_size`, filesystem sizes for both DB/WAL files, `SUM(LENGTH(...))` for semantic text, and raw-store compressed/logical sums. Do not add unlike quantities without labelling `totalBytes` as physical files only.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/call-records/analytics.test.ts tests/unit/call-records/store.test.ts`

Expected: PASS.

```bash
git add src/call-records/analytics.ts src/call-records/types.ts src/call-records/store.ts tests/unit/call-records/analytics.test.ts
git commit -m "Answer collection health from one consistent call snapshot" \
  -m "Constraint: Success records remain authoritative; historical non-success counts are never inferred." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Timezone ranges, previous periods, aggregates, storage categories, partial sections." \
  -m "Not-tested: HTTP and Web rendering follow in later tasks."
```

### Task 2: Expose overview and context APIs

**Files:**
- Create: `src/routes/admin/call-observability.ts`
- Create: `tests/unit/routes/call-observability.test.ts`
- Modify: `src/routes/web.ts`
- Modify: `src/routes/admin/call-records.ts`
- Modify: `tests/unit/routes/call-records.test.ts`

- [ ] **Step 1: Write failing API validation tests**

```ts
it("returns a Today overview with explicit timezone", async () => {
  const response = await app.request("/admin/call-observability/overview?range=today&timezone=Asia%2FShanghai");
  expect(response.status).toBe(200);
  expect(analytics.getOverview).toHaveBeenCalledWith(expect.objectContaining({ preset: "today" }));
});

it.each([
  "range=month&timezone=UTC",
  "range=today&timezone=not-a-zone",
  "from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z",
])("rejects an invalid or overlong range: %s", async (query) => {
  expect((await app.request(`/admin/call-observability/overview?${query}`)).status).toBe(400);
});
```

- [ ] **Step 2: Run and verify 404/failure**

Run: `npx vitest run tests/unit/routes/call-observability.test.ts tests/unit/routes/call-records.test.ts`

Expected: FAIL because the new route is not mounted and context detail endpoints are absent.

- [ ] **Step 3: Implement read-only routes**

Add:

```text
GET /admin/call-observability/overview
GET /admin/call-contexts/:id/summary
GET /admin/call-contexts/:id/calls
```

Accept `range`, `timezone`, or explicit `from`/`to` up to 90 days. Context calls use `limit<=200` and `offset>=0`; missing context returns 404. Mount `createCallObservabilityRoutes()` in `createWebRoutes()`.

- [ ] **Step 4: Verify partial data and store-unavailable errors**

Add tests that one failed storage-size query produces `sections.storage.error` with other overview sections intact, and a fully unavailable permanent store returns 503.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/routes/call-observability.test.ts tests/unit/routes/call-records.test.ts`

Expected: PASS.

```bash
git add src/routes/admin/call-observability.ts src/routes/admin/call-records.ts src/routes/web.ts tests/unit/routes/call-observability.test.ts tests/unit/routes/call-records.test.ts
git commit -m "Let operators drill from collection health into active work" \
  -m "Constraint: Every endpoint is authenticated, range-bounded, and body-free until detail is requested." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Overview/context route validation, partial sections, pagination, 404 and 503 contracts." \
  -m "Not-tested: Client navigation follows in later tasks."
```

### Task 3: Expose semantic search, detail, and lazy raw evidence

**Files:**
- Modify: `src/routes/admin/call-records.ts`
- Modify: `src/call-records/store.ts`
- Modify: `src/call-records/raw-store.ts`
- Modify: `tests/unit/routes/call-records.test.ts`
- Modify: `tests/unit/call-records/store.test.ts`

- [ ] **Step 1: Write failing response-shape tests**

```ts
it("returns semantic detail without raw JSON", async () => {
  store.getSemantic.mockReturnValue(detailFixture());
  const response = await app.request("/admin/call-records/call-1");
  const body = await response.json();
  expect(body.content.responseText).toBe("final answer");
  expect(body).not.toHaveProperty("requestJson");
  expect(body.raw).toMatchObject({ state: "available", expiresAt: expect.any(String) });
});

it.each([
  ["expired", 410, "raw_expired"],
  ["missing", 409, "raw_missing"],
  ["unavailable", 404, "raw_unavailable"],
])("maps %s raw state", async (state, status, error) => {
  raw.get.mockReturnValue({ state });
  const response = await app.request("/admin/call-records/call-1/raw?part=request");
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/unit/routes/call-records.test.ts tests/unit/call-records/store.test.ts`

Expected: FAIL because detail still returns raw JSON and there is no raw subroute.

- [ ] **Step 3: Implement semantic list/search/detail**

Add `GET /admin/call-records/search` with `q`, range, metadata filters, relevance/time/latency/token sort, and bounded pagination. Return plain snippets and match offsets, never server-generated HTML. Change `GET /admin/call-records/:id` to semantic content plus metadata/projection/raw state only.

- [ ] **Step 4: Implement the raw route before the parameterized detail route**

Register `GET /admin/call-records/:id/raw` before `/:id`. Validate `part=request|response`; decompress within `raw_max_body_bytes`; verify SHA-256; map unknown call to `404 call_not_found` and raw states exactly as specified.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/routes/call-records.test.ts tests/unit/call-records/store.test.ts tests/unit/call-records/raw-store.test.ts`

Expected: PASS.

```bash
git add src/routes/admin/call-records.ts src/call-records/store.ts src/call-records/raw-store.ts tests/unit/routes/call-records.test.ts tests/unit/call-records/store.test.ts
git commit -m "Keep semantic reading fast and raw evidence deliberate" \
  -m "Constraint: Lists and detail never carry raw blobs; raw retrieval is explicit and bounded." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Semantic search/detail, safe snippets, raw state mapping, integrity and decompression bounds." \
  -m "Not-tested: Browser disclosure rendering follows in Task 7."
```

### Task 4: Add typed, abort-safe observability hooks

**Files:**
- Create: `shared/hooks/use-call-observability.ts`
- Create: `shared/hooks/use-call-observability.test.ts`
- Modify: `shared/hooks/use-call-records.ts`
- Modify: `web/src/hooks/use-call-records.test.tsx`

- [ ] **Step 1: Write failing stale-data and race tests**

```ts
it("keeps the last overview visible while refresh fails", async () => {
  fetchMock.mockResolvedValueOnce(ok(overviewFixture())).mockResolvedValueOnce(error(503));
  const { result } = renderHook(() => useCallOverview());
  await waitFor(() => expect(result.current.data).not.toBeNull());
  await act(() => result.current.refresh());
  expect(result.current.data?.success.count).toBe(128);
  expect(result.current.stale).toBe(true);
});

it("does not let an older call detail overwrite the latest selection", async () => {
  const { result } = renderHook(() => useCallDetail());
  act(() => { result.current.load("old"); result.current.load("new"); });
  resolveRequest("new", detailFixture({ id: "new" }));
  resolveRequest("old", detailFixture({ id: "old" }));
  await waitFor(() => expect(result.current.data?.id).toBe("new"));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run ../shared/hooks/use-call-observability.test.ts src/hooks/use-call-records.test.tsx`

Expected: FAIL on missing hooks.

- [ ] **Step 3: Implement one query state per screen**

Export `useCallOverview`, `useCallContext`, `useCallDetail`, and `useCallSearch`. Each owns an `AbortController`, keeps last successful data during refresh, exposes `loading|refreshing|stale|error`, and encodes `range/timezone` in URL parameters. Raw fetch remains a method on `useCallDetail`, not part of initial load.

- [ ] **Step 4: Verify and commit**

Run: `cd web && npx vitest run ../shared/hooks/use-call-observability.test.ts src/hooks/use-call-records.test.tsx`

Expected: PASS.

```bash
git add shared/hooks/use-call-observability.ts shared/hooks/use-call-observability.test.ts shared/hooks/use-call-records.ts web/src/hooks/use-call-records.test.tsx
git commit -m "Keep observability navigation stable across slow refreshes" \
  -m "Constraint: Older requests must never replace a newer context or call selection." \
  -m "Confidence: high" -m "Scope-risk: narrow" \
  -m "Tested: Refresh, stale data, abort races, ranges, search debounce, lazy raw fetch." \
  -m "Not-tested: Page composition follows in later tasks."
```

### Task 5: Build the level-one call dashboard

**Files:**
- Create: `web/src/pages/CallDashboardPage.tsx`
- Create: `web/src/components/call-observability/SuccessTrend.tsx`
- Create: `web/src/components/call-observability/ModelShare.tsx`
- Create: `web/src/components/call-observability/StorageComposition.tsx`
- Create: `web/src/components/call-observability/ContextTable.tsx`
- Create: `web/src/pages/__tests__/call-dashboard.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `shared/i18n/translations.ts`

- [ ] **Step 1: Write failing dashboard hierarchy tests**

```tsx
it("shows health, scale, outcomes and active contexts for Today", () => {
  renderDashboard(overviewFixture());
  expect(screen.getByRole("heading", { name: "调用大盘" })).toBeInTheDocument();
  expect(screen.getByText("35 秒前")).toBeInTheDocument();
  expect(screen.getByText("3.82M")).toBeInTheDocument();
  expect(screen.getByText("失败 2")).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Web UI 统一优化/ })).toBeInTheDocument();
});

it("distinguishes disabled, empty-range, stale and partial states", () => {
  // render each fixture and assert its explicit explanation/action
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run src/pages/__tests__/call-dashboard.test.tsx`

Expected: FAIL because the page and components do not exist.

- [ ] **Step 3: Compose the approved dashboard using shared components**

Render four `MetricCard`s, one outcome strip, success SVG trend, model share, storage composition, and active context `DataTable`. Use real buttons/links, chart text/legend alternatives, tabular numerals, and the 11/12/13/22/26 scale. `TimeRangeControl` defaults to Today and offers only Today/24h/7d in the primary UI.

No chart package is added. `SuccessTrend` uses an accessible `<svg role="img" aria-labelledby>` plus an adjacent hidden data table; `ModelShare` uses CSS conic gradient only as decoration and a visible text legend.

- [ ] **Step 4: Make observability the default route**

In `App.tsx`, map `#/` and `#/calls` to `CallDashboardPage`; move the old pool overview to `#/accounts` without removing account functionality. Preserve legacy `#/call-records` by redirecting it to `#/calls`.

- [ ] **Step 5: Verify and commit**

Run: `cd web && npx vitest run src/pages/__tests__/call-dashboard.test.tsx src/App.test.tsx`

Expected: PASS.

```bash
git add web/src/pages/CallDashboardPage.tsx web/src/components/call-observability web/src/pages/__tests__/call-dashboard.test.tsx web/src/App.tsx shared/i18n/translations.ts
git commit -m "Put current model activity ahead of raw record browsing" \
  -m "Constraint: The first screen must answer recency, health, scale, model share, and active work without search." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Dashboard hierarchy, range control, all data states, accessible charts, default-route compatibility." \
  -m "Not-tested: Context and detail drill-down follow next."
```

### Task 6: Build context drill-down and timeline

**Files:**
- Create: `web/src/pages/CallContextPage.tsx`
- Create: `web/src/components/call-observability/CallTimeline.tsx`
- Create: `web/src/pages/__tests__/call-context.test.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Write failing navigation and context-metric tests**

```tsx
it("opens a context from the overview and keeps the range", async () => {
  renderAppAt("#/calls?range=24h");
  await user.click(screen.getByRole("link", { name: /Web UI 统一优化/ }));
  expect(location.hash).toBe("#/calls/context/ctx-1?range=24h");
});

it("renders context metrics and a latest-first semantic timeline", () => {
  renderContext(contextFixture());
  expect(screen.getByText("37 次成功调用")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /调用详情/ })[0]).toHaveTextContent("15:28:41");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run src/pages/__tests__/call-context.test.tsx src/App.test.tsx`

Expected: FAIL on missing route/page.

- [ ] **Step 3: Implement hash route parsing and context page**

Parse `#/calls/context/:id` and `#/calls/:id` without adding a routing dependency. Context page shows call count/last success, tokens, logical bytes, average/P95 latency, model/protocol mix, tool counts, and latest-first paginated timeline. Breadcrumb is visible on desktop; the shared shell collapses it on phone.

- [ ] **Step 4: Verify and commit**

Run: `cd web && npx vitest run src/pages/__tests__/call-context.test.tsx src/App.test.tsx`

Expected: PASS.

```bash
git add web/src/pages/CallContextPage.tsx web/src/components/call-observability/CallTimeline.tsx web/src/pages/__tests__/call-context.test.tsx web/src/App.tsx
git commit -m "Make each session explain where its usage came from" \
  -m "Constraint: Drill-down preserves range and returns through an explicit breadcrumb, never a hidden context filter." \
  -m "Confidence: high" -m "Scope-risk: narrow" \
  -m "Tested: Context metrics, ordering, pagination, route encoding, breadcrumb and phone label behavior." \
  -m "Not-tested: Call detail and raw evidence follow next."
```

### Task 7: Build semantic call detail and raw disclosure

**Files:**
- Create: `web/src/pages/CallDetailPage.tsx`
- Create: `web/src/components/call-observability/SemanticMessage.tsx`
- Create: `web/src/components/call-observability/RawEvidenceDisclosure.tsx`
- Create: `web/src/components/call-observability/JsonTree.tsx`
- Create: `web/src/components/call-observability/EventTimeline.tsx`
- Modify: `web/src/pages/__tests__/call-records.test.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Replace raw-first tests with semantic-first failing tests**

```tsx
it("shows current input and final output before raw evidence", () => {
  renderDetail(detailFixture());
  const headings = screen.getAllByRole("heading").map((node) => node.textContent);
  expect(headings.indexOf("用户输入")).toBeLessThan(headings.indexOf("原始证据"));
  expect(screen.getByText("final answer")).toBeInTheDocument();
  expect(screen.queryByText(/request_json/)).not.toBeInTheDocument();
});

it("fetches raw evidence only after expansion", async () => {
  renderDetail(detailFixture({ raw: { state: "available" } }));
  expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/raw"), expect.anything());
  await user.click(screen.getByRole("button", { name: /查看原始证据/ }));
  expect(fetch).toHaveBeenCalledWith("/admin/call-records/call-1/raw?part=request", expect.anything());
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run src/pages/__tests__/call-records.test.tsx`

Expected: FAIL because the current page renders two raw `<pre>` blocks.

- [ ] **Step 3: Implement semantic detail hierarchy**

Render status/IDs, user/developer content, final assistant output, tool summaries, stable metadata, projection/truncation notices, then raw state. Use `CopyButton` for IDs/text. Treat stored content as text only.

- [ ] **Step 4: Implement dependency-free raw viewers**

`JsonTree` recursively renders arrays/objects with `<details>` and a depth/entry guard. `EventTimeline` groups event type counts and filters the bounded event list. Expired/missing/unavailable messages are distinct. Never auto-open or fetch raw evidence.

- [ ] **Step 5: Verify and commit**

Run: `cd web && npx vitest run src/pages/__tests__/call-records.test.tsx src/App.test.tsx`

Expected: PASS.

```bash
git add web/src/pages/CallDetailPage.tsx web/src/components/call-observability web/src/pages/__tests__/call-records.test.tsx web/src/App.tsx
git commit -m "Let people read the call before opening protocol evidence" \
  -m "Constraint: Raw bodies are lazy, collapsed, bounded and never trusted as HTML." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Semantic ordering, projection notices, raw states, lazy fetch, JSON depth guard, event filters." \
  -m "Not-tested: Global search follows next."
```

### Task 8: Add global semantic search and advanced filters

**Files:**
- Create: `web/src/components/call-observability/CallSearchDialog.tsx`
- Create: `web/src/components/call-observability/CallSearchDialog.test.tsx`
- Modify: `web/src/components/app-shell/TopBar.tsx`
- Modify: `shared/hooks/use-call-observability.ts`
- Modify: `shared/i18n/translations.ts`

- [ ] **Step 1: Write failing keyboard, debounce, and safe-highlight tests**

```tsx
it("opens with Ctrl/Cmd+K and returns focus to its trigger", async () => {
  renderSearch();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "搜索调用与会话" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "搜索调用与会话" })).toHaveFocus();
});

it("renders snippets as text even when they contain markup", () => {
  renderResults([{ snippet: "<img src=x onerror=alert(1)>needle", matches: [[32, 38]] }]);
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText("needle")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run src/components/call-observability/CallSearchDialog.test.tsx ../shared/hooks/use-call-observability.test.ts`

Expected: FAIL on missing dialog and hook behavior.

- [ ] **Step 3: Implement the dialog and progressive filters**

Always show query, range, model and protocol. Put session/task/cwd/provider/account/stream/sort behind “Advanced filters”; show active filters as removable chips. Debounce 250ms, cancel stale requests, and build highlights with text nodes from server offsets.

The range field starts with Today/24h/7d. “Custom range” appears only inside Advanced filters, validates ISO-local start/end plus browser timezone, and refuses windows above 90 days.

- [ ] **Step 4: Verify and commit**

Run: `cd web && npx vitest run src/components/call-observability/CallSearchDialog.test.tsx ../shared/hooks/use-call-observability.test.ts`

Expected: PASS.

```bash
git add web/src/components/call-observability/CallSearchDialog.tsx web/src/components/call-observability/CallSearchDialog.test.tsx web/src/components/app-shell/TopBar.tsx shared/hooks/use-call-observability.ts shared/i18n/translations.ts
git commit -m "Make remembered requests searchable without exposing protocol noise" \
  -m "Constraint: Search snippets remain plain text and advanced filters stay secondary." \
  -m "Confidence: high" -m "Scope-risk: narrow" \
  -m "Tested: Keyboard dialog, focus return, debounce, abort races, filters, safe highlight rendering." \
  -m "Not-tested: Full visual regression follows in final verification."
```

### Task 9: Complete dashboard verification

**Files:**
- Modify only files owned by this plan if verification exposes defects.

- [ ] **Step 1: Run backend analytics and route tests**

```bash
npx vitest run tests/unit/call-records/analytics.test.ts tests/unit/routes/call-observability.test.ts tests/unit/routes/call-records.test.ts tests/unit/call-records/store.test.ts tests/unit/call-records/raw-store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all observability Web tests and build**

```bash
npm run test:web
npm run build
```

Expected: all Web tests, Vite build, and TypeScript compilation exit 0.

- [ ] **Step 3: Run authenticated smoke checks**

With a temporary config/data directory and server bound to `0.0.0.0`, verify through an authenticated cookie session:

```text
GET /admin/call-observability/overview?range=today&timezone=Asia/Shanghai  -> 200
GET /admin/call-contexts/:id/summary                                   -> 200
GET /admin/call-records/:id                                            -> semantic body, no raw JSON
GET /admin/call-records/:id/raw?part=response                           -> 200 or explicit raw state
```

Also verify an unauthenticated remote request receives 401.

- [ ] **Step 4: Capture required visual evidence**

Capture 1440×1050 light/dark overview, context, detail, and 390×844 phone overview/detail. Compare to the approved artifacts using `visual-verdict`; persist `.omx/state/visual-observability-implementation/ralph-progress.json` with score ≥90 and no known console errors.

- [ ] **Step 5: Commit only verified fixes, if any**

Do not make an empty commit. If fixes are required, use a Lore commit whose `Tested:` trailer lists the exact backend, Web, build, smoke and visual evidence.

## Dashboard completion gate

- Today/24h/7d update every panel consistently.
- Health/recency, usage/cache, storage/growth, success trend, model share, outcomes, and active contexts are visible without search.
- Context and call drill-down retain navigation state.
- Detail is semantic-first and raw evidence is lazy.
- Search is semantic, abort-safe, filterable, keyboard accessible, and XSS-safe.
- Desktop is complete; phone overview/context/detail are readable.
- `npm run build` and visual-verdict ≥90 pass.
