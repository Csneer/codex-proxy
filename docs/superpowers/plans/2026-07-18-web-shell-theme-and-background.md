# Web Shell, Theme, and Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every dashboard page one desktop-first icon-rail shell, fixed typography system, transparent light/dark theme, and secure server-shared custom background without changing existing business workflows.

**Architecture:** Move layout and presentation into focused `app-shell` and `ui` primitives backed by semantic CSS variables, then migrate existing pages incrementally. Store appearance metadata through authenticated admin APIs and one server-owned raster asset; browsers retain only light/dark preference. Background validation is dependency-free, atomic, and protected by the data-foundation plan's shared admin mutation guard.

**Tech Stack:** Preact, TypeScript, Tailwind 3, CSS custom properties, Hono, Node filesystem APIs, Vitest, Testing Library, headless Chromium visual verification.

**Prerequisites:** Complete Tasks 2–3 of the data-foundation plan so `adminFetch`, the CSRF guard, and configuration compatibility exist. Execute in a dedicated worktree. Keep `DESIGN.md` open while implementing; it is the visual decision contract.

---

## File structure

- Create `web/src/components/app-shell/AppShell.tsx`: background/workbench/chrome layout and responsive main region.
- Create `web/src/components/app-shell/IconRail.tsx`: primary navigation with labelled icons and active state.
- Create `web/src/components/app-shell/TopBar.tsx`: breadcrumbs, search slot, collection state, theme and appearance triggers.
- Create `web/src/components/app-shell/AppearanceDrawer.tsx`: background upload and bounded glass controls.
- Create `web/src/components/ui/*`: page header, card, panel, table, status, range, alert, skeleton, and empty-state primitives.
- Create `web/src/icons.tsx`: consistent repo-native outline SVG icon map.
- Create `shared/hooks/use-ui-appearance.ts`: server settings/background metadata and mutation methods.
- Create `src/ui-appearance/store.ts`: validated settings and atomic raster asset ownership.
- Create `src/ui-appearance/image-metadata.ts`: PNG/JPEG/WebP magic-byte and dimension parser.
- Create `src/routes/admin/ui-appearance.ts`: authenticated settings and background routes.
- Modify `web/src/index.css`, `web/tailwind.config.ts`, `shared/theme/context.tsx`: semantic tokens and browser-local mode.
- Modify `web/src/App.tsx`, `web/src/components/Header.tsx`, and existing pages/components: adopt the shell/primitives without changing business logic.

### Task 1: Lock the typography and semantic token contract

**Files:**
- Create: `web/src/design-tokens.test.ts`
- Modify: `web/src/index.css`
- Modify: `web/tailwind.config.ts`
- Modify: `shared/theme/context.test.ts`

- [ ] **Step 1: Write failing token tests**

```ts
it("defines only the approved operational type roles", () => {
  const css = readFileSync(resolve("web/src/index.css"), "utf8");
  expect(css).toContain("--text-meta: 11px");
  expect(css).toContain("--text-control: 12px");
  expect(css).toContain("--text-body: 13px");
  expect(css).toContain("--text-section: 16px");
  expect(css).toContain("--text-page: 22px");
  expect(css).toContain("--text-metric: 26px");
  expect(css).not.toMatch(/--text-(?:micro|xs):\s*(?:8|9|10)px/);
});

it("uses terracotta as accent and green only as success", () => {
  expect(tokens.light.accent).toBe("189 96 65");
  expect(tokens.dark.accent).toBe("223 121 87");
  expect(tokens.light.success).not.toBe(tokens.light.accent);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run src/design-tokens.test.ts ../shared/theme/context.test.ts`

Expected: FAIL because the current tokens are emerald-first and have no approved type scale.

- [ ] **Step 3: Replace global tokens with semantic variables**

```css
:root {
  --text-meta: 11px; --text-control: 12px; --text-body: 13px;
  --text-section: 16px; --text-page: 22px; --text-metric: 26px;
  --font-ui: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-identity: ui-serif, "Iowan Old Style", "Noto Serif SC", "Songti SC", serif;
  --accent: 189 96 65; --success: 57 119 78; --warning: 140 88 43; --danger: 185 28 28;
  --workbench-alpha: .38; --card-alpha: .49; --background-brightness: .72;
  --background-blur: 2px; --surface-blur: 4px;
}
.dark {
  --accent: 223 121 87; --success: 142 209 164;
  --workbench-alpha: .36; --card-alpha: .48; --background-brightness: .52;
}
```

Define semantic surface/text/border/chart tokens and Tailwind aliases. Keep legacy token aliases temporarily if existing components still consume them, but map them to the new semantics and remove them after page migration.

- [ ] **Step 4: Add typography utility classes**

Add `.text-meta`, `.text-control`, `.text-reading`, `.text-section`, `.text-page-title`, and `.text-metric`; enforce tabular numerals for metric/time/token/size utilities. The 16px class is documented and tested as valid only on dialog/drawer titles or standalone multi-panel headings.

- [ ] **Step 5: Verify and commit**

Run: `cd web && npx vitest run src/design-tokens.test.ts ../shared/theme/context.test.ts`

Expected: PASS.

```bash
git add web/src/index.css web/tailwind.config.ts web/src/design-tokens.test.ts shared/theme/context.test.ts
git commit -m "Make dashboard hierarchy consistent before restyling its pages" \
  -m "Constraint: No operational text below 11px; 16px has only two documented heading roles." \
  -m "Rejected: Per-page font sizing | it caused the inconsistent hierarchy reported by the user." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Type scale, palette semantics, dark/light tokens and theme preference regression." \
  -m "Not-tested: Components adopt tokens in later tasks."
```

### Task 2: Implement validated server appearance and background storage

**Files:**
- Create: `src/ui-appearance/image-metadata.ts`
- Create: `src/ui-appearance/store.ts`
- Create: `tests/unit/ui-appearance/image-metadata.test.ts`
- Create: `tests/unit/ui-appearance/store.test.ts`
- Modify: `src/config-schema.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Write failing raster validation and atomic replacement tests**

```ts
it.each([
  [pngFixture(3840, 2160), "image/png", 3840, 2160],
  [jpegFixture(1920, 1080), "image/jpeg", 1920, 1080],
  [webpFixture(1024, 768), "image/webp", 1024, 768],
])("reads supported magic bytes", (bytes, type, width, height) => {
  expect(readRasterMetadata(bytes)).toEqual({ type, width, height, animated: false });
});

it("keeps the previous asset when replacement validation fails", async () => {
  await store.replaceBackground(validPng);
  const before = await store.getBackgroundMetadata();
  await expect(store.replaceBackground(svgBytes)).rejects.toThrow("unsupported_image");
  expect(await store.getBackgroundMetadata()).toEqual(before);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/unit/ui-appearance/image-metadata.test.ts tests/unit/ui-appearance/store.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Add approved configuration bounds**

```ts
ui: z.object({
  background: z.object({
    enabled: z.boolean().default(false),
    fit: z.enum(["cover", "contain"]).default("cover"),
    position_x: z.number().min(0).max(100).default(50),
    position_y: z.number().min(0).max(100).default(50),
  }).default({}),
  appearance: z.object({
    panel_opacity_light: z.number().min(.24).max(.72).default(.38),
    card_opacity_light: z.number().min(.30).max(.82).default(.49),
    panel_opacity_dark: z.number().min(.24).max(.72).default(.36),
    card_opacity_dark: z.number().min(.30).max(.82).default(.48),
    background_brightness_light: z.number().min(.35).max(1).default(.72),
    background_brightness_dark: z.number().min(.35).max(1).default(.52),
    background_blur_px: z.number().min(0).max(12).default(2),
  }).default({}),
}).default({}),
```

- [ ] **Step 4: Implement dependency-free image parsing and atomic ownership**

Read PNG IHDR, JPEG SOF, and WebP VP8/VP8L/VP8X headers. Reject SVG/GIF/animated WebP, files above 16 MiB, zero dimensions, or either dimension above 8192. `replaceBackground()` writes a generated name under `getDataDir()/ui`, fsyncs the temporary file, renames atomically, updates metadata only after success, and then removes the old asset. Ignore client filenames and MIME values.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/ui-appearance/image-metadata.test.ts tests/unit/ui-appearance/store.test.ts tests/unit/config-schema.test.ts`

Expected: PASS.

```bash
git add src/ui-appearance src/config-schema.ts config/default.yaml tests/unit/ui-appearance tests/unit/config-schema.test.ts
git commit -m "Keep custom dashboard imagery server-owned and inert" \
  -m "Constraint: Accept only bounded static PNG, JPEG or WebP content under the application data directory." \
  -m "Rejected: Trusting filename or MIME | active or malformed content could bypass validation." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Magic bytes, dimensions, size limits, animation rejection, atomic replacement, prior-asset preservation." \
  -m "Not-tested: Authenticated HTTP endpoints follow next."
```

### Task 3: Expose authenticated appearance and background APIs

**Files:**
- Create: `src/routes/admin/ui-appearance.ts`
- Create: `tests/unit/routes/ui-appearance.test.ts`
- Modify: `src/routes/web.ts`
- Modify: `src/routes/admin/settings.ts`

- [ ] **Step 1: Write failing API/security tests**

```ts
it("returns shared appearance without exposing a filesystem path", async () => {
  const response = await app.request("/admin/ui-appearance");
  expect(await response.json()).toEqual(expect.objectContaining({
    background: { enabled: true, url: "/admin/ui-background", width: 3840, height: 2160 },
  }));
  expect(JSON.stringify(await response.clone().json())).not.toContain("/home/");
});

it("atomically replaces a valid multipart background", async () => {
  const response = await csrfRequest(app, "/admin/ui-background", { method: "POST", body: formWith(validPng) });
  expect(response.status).toBe(200);
  expect(store.replaceBackground).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/unit/routes/ui-appearance.test.ts tests/unit/middleware/admin-mutation-guard.test.ts`

Expected: FAIL on missing route.

- [ ] **Step 3: Implement routes and exact response shapes**

```text
GET    /admin/ui-appearance
PATCH  /admin/ui-appearance
POST   /admin/ui-background
GET    /admin/ui-background
DELETE /admin/ui-background
```

PATCH parses only approved fields and persists them through the existing local-settings mechanism. GET background uses authenticated streaming, `ETag` from SHA-256, `Cache-Control: private, max-age=3600`, and conditional 304. POST reads one multipart `file`, passes bytes to the store, and returns metadata. DELETE removes the owned file and switches to pure mode. All mutations use the shared CSRF guard.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/unit/routes/ui-appearance.test.ts tests/unit/middleware/admin-mutation-guard.test.ts tests/unit/routes/general-settings.test.ts`

Expected: PASS.

```bash
git add src/routes/admin/ui-appearance.ts src/routes/web.ts src/routes/admin/settings.ts tests/unit/routes/ui-appearance.test.ts
git commit -m "Share one controlled dashboard backdrop across authenticated devices" \
  -m "Constraint: Binary content never enters YAML or unauthenticated responses." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Appearance bounds, multipart upload, authenticated serving, ETag, atomic delete, CSRF." \
  -m "Not-tested: Browser controls follow next."
```

### Task 4: Create reusable UI primitives and fixed typography roles

**Files:**
- Create: `web/src/components/ui/PageHeader.tsx`
- Create: `web/src/components/ui/MetricCard.tsx`
- Create: `web/src/components/ui/DataPanel.tsx`
- Create: `web/src/components/ui/DataTable.tsx`
- Create: `web/src/components/ui/StatusBadge.tsx`
- Create: `web/src/components/ui/TimeRangeControl.tsx`
- Create: `web/src/components/ui/InlineAlert.tsx`
- Create: `web/src/components/ui/Skeleton.tsx`
- Create: `web/src/components/ui/EmptyState.tsx`
- Create: `web/src/components/ui/ui.test.tsx`

- [ ] **Step 1: Write failing semantic and class-role tests**

```tsx
it("uses the fixed metric and metadata roles", () => {
  render(<MetricCard label="成功调用" value="128" hint="较昨日 +12%" />);
  expect(screen.getByText("128")).toHaveClass("text-metric", "tabular-nums");
  expect(screen.getByText("较昨日 +12%")).toHaveClass("text-meta");
});

it("renders a real table and labels icon-only status", () => {
  render(<DataTable columns={columns} rows={rows} />);
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByText("正常")).toHaveAccessibleName(/正常/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run src/components/ui/ui.test.tsx`

Expected: FAIL because primitives do not exist.

- [ ] **Step 3: Implement focused primitives**

Each file owns one responsibility and accepts `class`/children where appropriate. `DataTable` uses semantic `<table>` and an optional mobile overflow wrapper. `TimeRangeControl` supports only Today/24h/7d. Status text accompanies every color. Loading/empty/error components preserve panel geometry and accessible live-region behavior.

- [ ] **Step 4: Verify and commit**

Run: `cd web && npx vitest run src/components/ui/ui.test.tsx`

Expected: PASS.

```bash
git add web/src/components/ui
git commit -m "Give dashboard data one reusable visual grammar" \
  -m "Constraint: Density comes from layout and alignment, never sub-11px text." \
  -m "Confidence: high" -m "Scope-risk: narrow" \
  -m "Tested: Semantic tables, type roles, status labels, range control, loading/empty/error states." \
  -m "Not-tested: Application shell composition follows next."
```

### Task 5: Build the icon-rail application shell

**Files:**
- Create: `web/src/icons.tsx`
- Create: `web/src/components/app-shell/AppShell.tsx`
- Create: `web/src/components/app-shell/IconRail.tsx`
- Create: `web/src/components/app-shell/TopBar.tsx`
- Create: `web/src/components/app-shell/AppShell.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/Header.tsx`

- [ ] **Step 1: Write failing navigation/responsive tests**

```tsx
it("renders one labelled icon rail and identifies the active page", () => {
  renderShell("#/accounts");
  expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "账号" })).toHaveAttribute("aria-current", "page");
});

it("collapses mobile breadcrumbs to the current page", () => {
  renderShell("#/calls/context/ctx-1/call-1");
  expect(screen.getByTestId("mobile-current-page")).toHaveTextContent("调用详情");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run src/components/app-shell/AppShell.test.tsx src/App.test.tsx`

Expected: FAIL because the app still uses `Header`, text tabs, and a narrow 960px container.

- [ ] **Step 3: Implement one outline SVG icon set and shell**

`icons.tsx` exports Preact SVG components with the same 24×24 viewBox/stroke rules. `IconRail` receives route definitions and renders tooltips plus visually hidden labels. `TopBar` accepts breadcrumbs/search/status slots and theme/appearance buttons. `AppShell` provides background layers, 18px workbench radius on desktop, rail/main grid, nearly full content width, and phone layout with rail hidden.

- [ ] **Step 4: Replace the top tabs without changing route content**

Remove `TabBar`; render the same existing pages inside `AppShell`. Keep legacy hash redirects. Retain `Header` exports temporarily only for isolated page tests, then delete it when no imports remain. Do not move page business logic in this step.

- [ ] **Step 5: Verify and commit**

Run: `cd web && npx vitest run src/components/app-shell/AppShell.test.tsx src/App.test.tsx`

Expected: PASS.

```bash
git add web/src/icons.tsx web/src/components/app-shell web/src/App.tsx web/src/App.test.tsx web/src/components/Header.tsx
git commit -m "Give every dashboard workflow one navigable workbench" \
  -m "Constraint: Preserve existing routes and business components while replacing page-specific navigation." \
  -m "Confidence: high" -m "Scope-risk: broad" \
  -m "Tested: Active navigation, labels/tooltips, breadcrumbs, legacy redirects, desktop and phone shell structure." \
  -m "Not-tested: Background controls and page-by-page visual migration follow next."
```

### Task 6: Connect browser-local theme and server-shared appearance controls

**Files:**
- Create: `shared/hooks/use-ui-appearance.ts`
- Create: `shared/hooks/use-ui-appearance.test.ts`
- Create: `web/src/components/app-shell/AppearanceDrawer.tsx`
- Create: `web/src/components/app-shell/AppearanceDrawer.test.tsx`
- Modify: `shared/theme/context.tsx`
- Modify: `web/src/components/app-shell/AppShell.tsx`
- Modify: `web/src/components/app-shell/TopBar.tsx`
- Modify: `shared/i18n/translations.ts`

- [ ] **Step 1: Write failing persistence and control tests**

```tsx
it("keeps theme browser-local while loading shared appearance", async () => {
  localStorage.setItem("codex-proxy-theme", "dark");
  fetchMock.mockResolvedValue(ok(appearanceFixture({ panel_opacity_dark: .36 })));
  renderProviders();
  expect(document.documentElement).toHaveClass("dark");
  expect(document.documentElement.style.getPropertyValue("--workbench-alpha")).toBe("0.36");
});

it("allows blur zero and restores approved defaults", async () => {
  render(<AppearanceDrawer />);
  await user.clear(screen.getByLabelText("背景模糊"));
  await user.type(screen.getByLabelText("背景模糊"), "0");
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(adminFetch).toHaveBeenCalledWith("/admin/ui-appearance", expect.objectContaining({ method: "PATCH" }));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd web && npx vitest run ../shared/hooks/use-ui-appearance.test.ts src/components/app-shell/AppearanceDrawer.test.tsx ../shared/theme/context.test.ts`

Expected: FAIL on missing hook/drawer.

- [ ] **Step 3: Implement shared appearance loading and bounded CSS overrides**

The hook GETs server settings, applies theme-specific CSS properties to the shell, and uses `adminFetch` for PATCH/upload/delete. It never writes server appearance to localStorage. ThemeProvider continues to store only `codex-proxy-theme`. A contrast guard clamps card/workbench alpha upward when `prefers-reduced-transparency` matches or when the selected alpha is below documented safe minima.

- [ ] **Step 4: Implement the drawer**

Render current image preview/metadata, upload/replace/delete, cover/contain, X/Y position, panel/card opacity, theme-specific brightness, blur 0–12px, pure mode, save/reset. Use a 16px drawer title and 12px controls; preview upload errors without losing the current background.

- [ ] **Step 5: Verify and commit**

Run: `cd web && npx vitest run ../shared/hooks/use-ui-appearance.test.ts src/components/app-shell/AppearanceDrawer.test.tsx ../shared/theme/context.test.ts`

Expected: PASS.

```bash
git add shared/hooks/use-ui-appearance.ts shared/hooks/use-ui-appearance.test.ts shared/theme/context.tsx web/src/components/app-shell shared/i18n/translations.ts
git commit -m "Let each browser choose its light while sharing one backdrop" \
  -m "Constraint: Theme preference is local; background and glass parameters are server-owned and contrast-bounded." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: Theme locality, shared loading, upload/replace/delete, zero blur, reset, reduced transparency, focus return." \
  -m "Not-tested: Existing page migration follows next."
```

### Task 7: Migrate existing pages to shared components without behavior changes

**Files:**
- Modify: `web/src/pages/AccountManagement.tsx`
- Modify: `web/src/pages/ProxySettings.tsx`
- Modify: `web/src/pages/UsageStats.tsx`
- Modify: `web/src/pages/LogsPage.tsx`
- Modify: `web/src/pages/ErrorsPage.tsx`
- Modify: `web/src/components/ApiKeyManager.tsx`
- Modify: `web/src/components/SettingsTab.tsx`
- Modify: account/proxy/settings child components only where a hardcoded surface/type class prevents shared tokens
- Modify: corresponding existing tests

- [ ] **Step 1: Add a failing repository guard against undersized operational classes**

```ts
it("does not introduce sub-11px operational text in migrated dashboard sources", () => {
  const source = readDashboardSources();
  expect(source).not.toMatch(/text-\[(?:0\.[0-6]rem|[0-9]|10px)\]/);
});
```

Whitelist only icon geometry and non-text SVG coordinates; do not whitelist user-visible labels.

- [ ] **Step 2: Run existing page tests plus the guard**

Run:

```bash
cd web && npx vitest run src/design-tokens.test.ts src/pages/__tests__/logs.test.tsx src/pages/__tests__/usage-stats.test.tsx src/components/ApiKeyManager.test.tsx src/components/AccountList.test.tsx
```

Expected: the new typography guard FAILS on existing `text-[0.68rem]`, `text-[0.78rem]`, and similar classes; existing behavior tests pass.

- [ ] **Step 3: Migrate one page family at a time**

For each page: use `PageHeader`, `DataPanel`, `DataTable`, `StatusBadge`, `InlineAlert`, and fixed type roles; remove standalone page backgrounds/headers; preserve event handlers, fetch hooks, confirmation text, table columns, pagination, and empty/error behavior. Run that page's existing tests immediately after its edit.

Migration order:

1. Logs and Errors;
2. Usage;
3. Accounts and API keys;
4. Proxy pages;
5. Settings and modals;
6. Login gate and Footer.

- [ ] **Step 4: Remove obsolete visual classes and Header/TabBar remnants**

After `rg 'Header|TabBar|bg-slate-50|dark:bg-bg-dark|text-\[[^]]+\]' web/src` shows no obsolete page shell or undersized text, remove unused `Header.tsx` and dead Tailwind token aliases. Do not delete business components.

- [ ] **Step 5: Verify and commit per page family**

After each family, run its tests and create a Lore commit. Example for logs/errors:

```bash
git add web/src/pages/LogsPage.tsx web/src/pages/ErrorsPage.tsx web/src/pages/__tests__/logs.test.tsx web/src/design-tokens.test.ts
git commit -m "Make diagnostic pages readable inside the shared workbench" \
  -m "Constraint: Preserve filtering, selection, raw detail and error-count behavior." \
  -m "Confidence: high" -m "Scope-risk: narrow" \
  -m "Tested: Logs and errors page suites plus typography guard." \
  -m "Not-tested: Remaining page families migrate in subsequent commits."
```

Repeat with exact files and behavior tests for each family; never combine all page migrations into one broad commit.

### Task 8: Complete accessibility, responsive, build, and visual verification

**Files:**
- Create: `web/src/components/app-shell/responsive.test.tsx`
- Modify only Web shell/theme files when verification proves a defect.

- [ ] **Step 1: Run the complete Web test suite**

Run: `npm run test:web`

Expected: PASS with zero failures.

- [ ] **Step 2: Run static scans and production build**

```bash
rg -n 'text-\[(?:0\.[0-6]rem|[0-9]|10px)\]' web/src && exit 1 || true
rg -n 'backdrop-filter:.*(?:20|30|40)px|filter:.*url\(|displacement|refraction|parallax' web/src && exit 1 || true
npm run build
```

Expected: scans find no forbidden operational text/effects; build exits 0.

- [ ] **Step 3: Run authenticated background smoke checks**

From a non-loopback authenticated browser/session, upload the approved sample image, reload another browser, verify the same background/parameters, switch only one browser to dark mode, set blur to 0, activate pure mode, restore the image, and confirm `/admin/*` mutations include CSRF. Existing accounts/proxies/settings operations must still work.

- [ ] **Step 4: Capture visual evidence and run the required verdict**

Capture at minimum:

- 1440×1050 light and dark shell with data page;
- 1440×1050 accounts, proxies, logs and settings;
- 390×844 read-oriented page and appearance drawer.

Compare against approved artifacts with `visual-verdict`, persist `.omx/state/visual-web-shell-implementation/ralph-progress.json`, require score ≥90, no console errors, no visible text under 11px, and no image bending/refraction.

- [ ] **Step 5: Commit only verification fixes, if any**

Do not create an empty commit. A fix commit must list exact Web tests, build, authenticated smoke states, viewport captures and visual score in the Lore `Tested:` trailer.

## Web shell completion gate

- Every existing page renders inside one icon-rail workbench and retains its business behavior.
- Typography follows 11/12/13/16/22/26 with the documented 16px restriction.
- Light and dark use the same server background; theme preference remains browser-local.
- Panel/card opacity, brightness and blur are bounded; blur accepts 0; pure mode always works.
- Only static PNG/JPEG/WebP is accepted and replacement is atomic.
- Desktop is complete, tablet functional, phone read-priority.
- All Web tests/build pass and visual-verdict is at least 90.
