# Service and Administration Key Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `server.proxy_api_key` a service-only credential and introduce a mandatory independent `dashboard.admin_key` that uniformly protects every local and remote management surface.

**Architecture:** Add a fail-closed configuration migration that persists a random administration key without changing the service-key default `pwd`. Centralize public/service/management route classification so the Dashboard session/admin Bearer policy and mutation CSRF policy share one boundary, while the proxy API-key middleware protects all service routes including model discovery. Keep browser administration cookie-and-CSRF based, expose only service-key controls in plaintext, and rotate the non-readable administration key through a dedicated UI action that revokes every session.

**Tech Stack:** TypeScript, Hono, Zod, Preact, Vitest, js-yaml, Node.js crypto.

## Global Constraints

- `server.proxy_api_key` remains the service credential and retains the first-run default value `pwd`.
- `dashboard.admin_key` is mandatory, independently generated, never derived from or allowed to fall back to `server.proxy_api_key`, and never returned by normal APIs or UI.
- Localhost, Electron, and reverse-proxy requests receive no management-authentication bypass.
- Browser management uses an HttpOnly session plus same-origin CSRF; management automation uses only `Bearer <dashboard.admin_key>`.
- Service endpoints accept only `server.proxy_api_key` or existing account-level `codex-proxy-*` keys.
- Preserve unrelated dirty-worktree changes and add no dependencies.
- Existing `official_agent.api_key` behavior remains unchanged.

## File structure

- Create `src/auth/route-auth-policy.ts`: pure classification of public, service, independently authenticated, and management paths.
- Modify `src/config-loader.ts`, `src/config-schema.ts`, `src/config.ts`, and `config/default.yaml`: strict administration-key generation, environment overrides, schema, and runtime configuration.
- Modify `src/middleware/dashboard-auth.ts` and `src/middleware/admin-mutation-guard.ts`: shared management policy with no localhost bypass and admin-only Bearer automation.
- Modify `src/routes/dashboard-login.ts`, `src/auth/dashboard-session.ts`, `src/routes/admin/settings.ts`, and `src/routes/models.ts`: admin login/status/session rotation, safe settings contract, and removal of route-local proxy-key management auth.
- Modify `src/index.ts` and service route mounting: global service authentication including `/v1/models*` and compatibility `/responses*`.
- Modify shared hooks and Web components: remove service Bearer from management requests and render separate service/admin key controls.
- Modify Ollama schema/tests and operator documentation: loopback-only inbound bridge and dual-key guidance.

---

### Task 1: Strict administration-key configuration and migration

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `src/config-loader.ts`
- Modify: `src/config.ts`
- Modify: `config/default.yaml`
- Modify: `.env.example`
- Modify: `tests/unit/config-schema.test.ts`
- Modify: `tests/unit/config-loader.test.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/_helpers/config.ts`

**Interfaces:**
- Produces: `AppConfig["dashboard"]` with `{ admin_key: string }`.
- Produces: environment overrides `CODEX_PROXY_API_KEY` and `CODEX_DASHBOARD_ADMIN_KEY`.
- Produces: persisted `dashboard.admin_key` generation inside `loadMergedConfig()` before `ConfigSchema.parse()`.

- [ ] **Step 1: Write failing schema and migration tests**

Add assertions equivalent to:

```ts
expect(ConfigSchema.parse(baseConfig).dashboard.admin_key).toBe("admin-secret");
expect(() => ConfigSchema.parse({ ...baseConfig, dashboard: { admin_key: "" } })).toThrow();

const loaded = loadMergedConfig(testConfigDir);
expect(loaded.raw.server).toMatchObject({ proxy_api_key: "pwd" });
expect((loaded.raw.dashboard as Record<string, unknown>).admin_key).toMatch(/^[a-f0-9]{64}$/);
expect((loaded.raw.dashboard as Record<string, unknown>).admin_key).not.toBe("pwd");
expect(readFileSync(localPath, "utf8")).toContain("admin_key:");
```

Also test that `CODEX_DASHBOARD_ADMIN_KEY=env-admin` prevents persistence/generation and that `CODEX_PROXY_API_KEY=env-service` overrides only `server.proxy_api_key`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/config-schema.test.ts tests/unit/config-loader.test.ts tests/unit/config.test.ts`

Expected: failures because `dashboard` and both environment overrides do not exist and cold start persists only `proxy_api_key: pwd`.

- [ ] **Step 3: Implement minimal strict migration**

Add the schema:

```ts
dashboard: z.object({
  admin_key: z.string().trim().min(1),
}),
```

Keep `config/default.yaml` structurally explicit with `dashboard: { admin_key: null }`; `loadMergedConfig()` must replace the null before parsing. Use `randomBytes(32).toString("hex")`. On a missing key with no environment override, merge the generated value into the existing `data/local.yaml`, persist it, and log exactly one generation notice containing the new key. If persistence throws, rethrow a startup error instead of continuing with an in-memory-only key.

In `applyEnvOverrides()` set:

```ts
if (process.env.CODEX_PROXY_API_KEY?.trim()) {
  (raw.server as Record<string, unknown>).proxy_api_key = process.env.CODEX_PROXY_API_KEY.trim();
}
if (process.env.CODEX_DASHBOARD_ADMIN_KEY?.trim()) {
  (raw.dashboard as Record<string, unknown>).admin_key = process.env.CODEX_DASHBOARD_ADMIN_KEY.trim();
}
```

Update typed test fixtures with `dashboard: { admin_key: "test-admin-key" }`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/config-schema.test.ts tests/unit/config-loader.test.ts tests/unit/config.test.ts`

Expected: all selected tests pass; cold-start tests prove service key `pwd` and a distinct persisted 64-hex-character administration key.

- [ ] **Step 5: Commit the configuration slice**

```bash
git add src/config-schema.ts src/config-loader.ts src/config.ts config/default.yaml .env.example tests/unit/config-schema.test.ts tests/unit/config-loader.test.ts tests/unit/config.test.ts tests/_helpers/config.ts
git commit -m "feat(auth): generate an independent dashboard key"
```

### Task 2: Central management-route policy and no-localhost-bypass authentication

**Files:**
- Create: `src/auth/route-auth-policy.ts`
- Create: `tests/unit/auth/route-auth-policy.test.ts`
- Modify: `src/middleware/dashboard-auth.ts`
- Modify: `src/middleware/admin-mutation-guard.ts`
- Modify: `tests/unit/middleware/dashboard-auth.test.ts`
- Modify: `tests/unit/middleware/admin-mutation-guard.test.ts`

**Interfaces:**
- Produces: `classifyRequestPath(path: string): "public" | "service" | "independent" | "management"`.
- `independent` covers `/official-agent/*`, which retains its own route authentication.
- Consumes: `getConfig().dashboard.admin_key` from Task 1.

- [ ] **Step 1: Write failing policy and middleware tests**

Create a table-driven policy test containing at least:

```ts
expect(classifyRequestPath("/assets/app.js")).toBe("public");
expect(classifyRequestPath("/auth/dashboard-login")).toBe("public");
expect(classifyRequestPath("/auth/callback")).toBe("public");
expect(classifyRequestPath("/v1/models")).toBe("service");
expect(classifyRequestPath("/responses")).toBe("service");
expect(classifyRequestPath("/official-agent/apps")).toBe("independent");
expect(classifyRequestPath("/auth/accounts/export")).toBe("management");
expect(classifyRequestPath("/auth/login-start")).toBe("management");
expect(classifyRequestPath("/api/proxies/import")).toBe("management");
expect(classifyRequestPath("/debug/models")).toBe("management");
expect(classifyRequestPath("/future-route")).toBe("management");
```

Update middleware tests to prove localhost without a session returns 401, service Bearer returns 401 on management routes, admin Bearer passes management routes, and the mutation guard applies to POST/DELETE/PATCH management routes outside `/admin/*`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/auth/route-auth-policy.test.ts tests/unit/middleware/dashboard-auth.test.ts tests/unit/middleware/admin-mutation-guard.test.ts`

Expected: failures because the classifier is absent, localhost currently bypasses authentication, and the mutation guard ignores non-`/admin` management paths.

- [ ] **Step 3: Implement the classifier and unified management middleware**

Implement an explicit prefix/exact-match classifier with default `management`. Public exact paths include `/`, `/health`, `/auth/dashboard-login`, `/auth/dashboard-logout`, `/auth/dashboard-status`, `/auth/dashboard-preferences`, and `/auth/callback`; public prefixes include `/assets/`. Service prefixes include `/v1/`, `/v1beta/`, and `/responses`. Independent prefixes include `/official-agent/`.

In `dashboardAuth`, immediately `next()` for public, service, and independent classifications. For management, accept either an exact `Bearer ${config.dashboard.admin_key}` or a valid Dashboard session cookie. Remove all localhost logic and all references to `server.proxy_api_key`.

In `adminMutationGuard`, act on every unsafe method whose classification is `management`. Allow exact admin Bearer only when no cookie header is present; otherwise require valid session, exact origin, and session-bound CSRF. Remove the localhost principal path.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/auth/route-auth-policy.test.ts tests/unit/middleware/dashboard-auth.test.ts tests/unit/middleware/admin-mutation-guard.test.ts`

Expected: all selected tests pass, including localhost denial and `/auth/*`/`/api/proxies/*` CSRF coverage.

- [ ] **Step 5: Commit the policy slice**

```bash
git add src/auth/route-auth-policy.ts tests/unit/auth/route-auth-policy.test.ts src/middleware/dashboard-auth.ts src/middleware/admin-mutation-guard.ts tests/unit/middleware/dashboard-auth.test.ts tests/unit/middleware/admin-mutation-guard.test.ts
git commit -m "feat(auth): enforce a unified management boundary"
```

### Task 3: Dashboard login, session revocation, and safe key-management API

**Files:**
- Modify: `src/auth/dashboard-session.ts`
- Modify: `src/routes/dashboard-login.ts`
- Modify: `src/routes/admin/settings.ts`
- Modify: `tests/unit/routes/dashboard-login.test.ts`
- Modify: `tests/integration/error-logs-dashboard-auth.test.ts`

**Interfaces:**
- Produces: `revokeAllSessions(): void` in `src/auth/dashboard-session.ts`.
- Produces GET `/admin/settings`: `{ proxy_api_key: string | null; admin_key_configured: true }`.
- Produces POST `/admin/settings` accepting `{ proxy_api_key?: string | null; admin_key?: string }` and returning `{ success: true; proxy_api_key: string | null; admin_key_configured: true; reauth_required: boolean }`.

- [ ] **Step 1: Write failing login and rotation tests**

Update login tests so `password: "admin-secret"` succeeds and `password: "service-secret"` fails even on localhost. Add tests proving status always returns `{ required: true }`, GET settings never returns `admin_key`, service-key clearing succeeds without disabling Dashboard auth, empty admin-key rotation returns 400, successful rotation persists `dashboard.admin_key`, and every pre-existing session/CSRF token becomes invalid.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/routes/dashboard-login.test.ts tests/integration/error-logs-dashboard-auth.test.ts`

Expected: failures because login/status use `proxy_api_key`, settings exposes only the service-key contract, and no all-session revocation API exists.

- [ ] **Step 3: Implement admin login and safe rotation**

Compare the submitted password with `config.dashboard.admin_key` using the existing length check plus `timingSafeEqual`. Dashboard status always reports `required: true` and authenticates only a valid session.

Implement:

```ts
export function revokeAllSessions(): void {
  for (const id of [...sessions.keys()]) removeSession(id);
}
```

For settings POST, validate a provided `admin_key` with `.trim()` and reject empty values. Persist service/admin changes in one YAML mutation. Reload config only after persistence succeeds. If the admin key changed, call `revokeAllSessions()` after reload and return `reauth_required: true`; otherwise preserve sessions. Never include the administration-key value in a response.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/routes/dashboard-login.test.ts tests/integration/error-logs-dashboard-auth.test.ts`

Expected: all selected tests pass and prove strict service/admin separation plus session revocation.

- [ ] **Step 5: Commit the Dashboard authentication slice**

```bash
git add src/auth/dashboard-session.ts src/routes/dashboard-login.ts src/routes/admin/settings.ts tests/unit/routes/dashboard-login.test.ts tests/integration/error-logs-dashboard-auth.test.ts
git commit -m "feat(auth): rotate dashboard credentials safely"
```

### Task 4: Service-route authentication, including model discovery

**Files:**
- Modify: `src/index.ts`
- Modify: `src/routes/models.ts`
- Modify: `tests/unit/routes/plan-routing-integration.test.ts`
- Create: `tests/unit/routes/service-admin-key-isolation.test.ts`
- Modify: `tests/unit/routes/official-agent.test.ts`

**Interfaces:**
- Consumes: `apiKeyAuth(accountPool)` and the service classification from Task 2.
- Produces: authenticated `/v1/models*`, `/v1beta/*`, `/v1/*`, and `/responses*` route families.

- [ ] **Step 1: Write failing service-boundary tests**

Create a production-ordered Hono test app and assert:

```ts
expect((await requestService("/v1/models", serviceKey)).status).toBe(200);
expect((await requestService("/v1/models", adminKey)).status).toBe(401);
expect((await requestManagement("/auth/status", serviceKey)).status).toBe(401);
expect((await requestManagement("/auth/status", adminKey)).status).toBe(200);
```

Retain the existing test that `official_agent.api_key` is required and both service/admin keys are rejected by Official Agent routes.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/routes/service-admin-key-isolation.test.ts tests/unit/routes/plan-routing-integration.test.ts tests/unit/routes/official-agent.test.ts`

Expected: `/v1/models*` remains public and service key still crosses into management through the old global policy.

- [ ] **Step 3: Mount global service authentication and remove route-local management auth**

After creating `accountPool` and before mounting routes, register `apiKeyAuth(accountPool)` for `/v1/*`, `/v1beta/*`, `/responses`, and `/responses/*`. Keep route-local service middleware only if removing it would cause an unrelated diff; double validation is not acceptable, so choose one layer and test each protocol error shape.

Remove the hand-written `server.proxy_api_key` Bearer check inside `POST /admin/refresh-models`; unified management auth and mutation CSRF become its only authorization.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/routes/service-admin-key-isolation.test.ts tests/unit/routes/plan-routing-integration.test.ts tests/unit/routes/official-agent.test.ts`

Expected: service/admin cross-use is rejected, model discovery is service-authenticated, and Official Agent tests remain unchanged.

- [ ] **Step 5: Commit the service-boundary slice**

```bash
git add src/index.ts src/routes/models.ts tests/unit/routes/service-admin-key-isolation.test.ts tests/unit/routes/plan-routing-integration.test.ts tests/unit/routes/official-agent.test.ts
git commit -m "feat(auth): restrict service routes to service keys"
```

### Task 5: Browser hooks and split-key Dashboard UI

**Files:**
- Modify: `shared/hooks/use-settings.ts`
- Modify: `shared/hooks/use-general-settings.ts`
- Modify: `shared/hooks/use-rotation-settings.ts`
- Modify: `shared/hooks/use-quota-settings.ts`
- Modify: `shared/hooks/use-ollama-settings.ts`
- Modify: `shared/hooks/use-dashboard-auth.ts`
- Modify: `shared/hooks/use-status.ts`
- Modify: `shared/http/admin-fetch.test.ts`
- Modify: `web/src/components/SettingsPanel.tsx`
- Modify: `web/src/components/GeneralSettings.tsx`
- Modify: `web/src/components/ModelAliasSettings.tsx`
- Modify: `web/src/components/LogsSettings.tsx`
- Modify: `web/src/components/QuotaSettings.tsx`
- Modify: `web/src/components/RotationSettings.tsx`
- Modify: `web/src/components/OllamaBridgeSettings.tsx`
- Modify: `web/src/pages/LogsPage.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/AnthropicSetup.tsx`
- Modify: `shared/i18n/translations.ts`
- Modify: `shared/hooks/use-dashboard-auth.test.ts`
- Create: `web/src/components/SettingsPanel.test.tsx`

**Interfaces:**
- `useSettings()` returns `apiKey`, `adminKeyConfigured`, `saveServiceKey()`, and `rotateAdminKey()`.
- `useGeneralSettings()`, `useRotationSettings()`, `useQuotaSettings()`, and `useOllamaSettings()` take no service-key argument.
- Export `notifyDashboardAuthExpired(): void` from `use-dashboard-auth.ts` for successful admin-key rotation.

- [ ] **Step 1: Write failing hook/UI tests**

Add tests that no management save sends `Authorization`, that `rotateAdminKey("new-admin")` posts only the new key and dispatches the auth-expired event after `{ reauth_required: true }`, and that SettingsPanel renders separate “Service API Key” and “Dashboard/Admin Key” controls without rendering an existing administration value.

Update `admin-fetch.test.ts` to retain arbitrary caller headers but prove the Dashboard hooks no longer supply the service Bearer.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run shared/hooks/use-dashboard-auth.test.ts shared/http/admin-fetch.test.ts && npm --prefix web exec vitest run src/components/SettingsPanel.test.tsx`

Expected: failures because hooks still accept and send the service key and the UI exposes only one key editor.

- [ ] **Step 3: Implement cookie/CSRF-only browser management and split UI**

Remove service-key parameters and Authorization construction from all management hooks. Keep `Content-Type` and `adminFetch()` for mutations.

Change the settings hook state to consume:

```ts
type KeySettings = {
  proxy_api_key: string | null;
  admin_key_configured: true;
};
```

Add separate service save and admin rotation methods. After a successful admin rotation with `reauth_required`, clear the CSRF cache and dispatch `codex:auth-expired` through the exported notifier.

Render two labeled sections in `SettingsPanel`. The administration input starts blank, uses a replacement placeholder, never receives a server value, rejects blank save, and warns that save logs out all sessions. Update all component call sites to invoke management hooks without `settings.apiKey`.

Update `use-status.ts` to pass the retrieved service key explicitly as an Authorization header when loading `/v1/models*`. Update `AnthropicSetup` in the same manner using its existing service-key source. Change login copy from proxy API key to Dashboard/Admin key.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run shared/hooks/use-dashboard-auth.test.ts shared/http/admin-fetch.test.ts && npm --prefix web exec vitest run src/components/SettingsPanel.test.tsx`

Expected: selected shared/Web tests pass; no browser management hook attaches a service Bearer.

- [ ] **Step 5: Commit the frontend slice**

```bash
git add shared/hooks/use-settings.ts shared/hooks/use-general-settings.ts shared/hooks/use-rotation-settings.ts shared/hooks/use-quota-settings.ts shared/hooks/use-ollama-settings.ts shared/hooks/use-dashboard-auth.ts shared/hooks/use-status.ts shared/http/admin-fetch.test.ts web/src/components/SettingsPanel.tsx web/src/components/GeneralSettings.tsx web/src/components/ModelAliasSettings.tsx web/src/components/LogsSettings.tsx web/src/components/QuotaSettings.tsx web/src/components/RotationSettings.tsx web/src/components/OllamaBridgeSettings.tsx web/src/pages/LogsPage.tsx web/src/App.tsx web/src/components/AnthropicSetup.tsx shared/i18n/translations.ts shared/hooks/use-dashboard-auth.test.ts web/src/components/SettingsPanel.test.tsx
git commit -m "feat(web): separate service and dashboard key controls"
```

### Task 6: Lock the Ollama bridge to loopback

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `src/routes/admin/ollama.ts`
- Modify: `tests/unit/config-schema.test.ts`
- Modify: `tests/unit/routes/ollama-settings.test.ts`
- Modify: `tests/unit/ollama/server.test.ts`

**Interfaces:**
- Produces: `ollama.host` restricted to `localhost`, `127.0.0.1`, or `::1`.
- Preserves: Ollama forwarding receives `config.server.proxy_api_key` only.

- [ ] **Step 1: Write failing loopback tests**

Add schema and route tests proving `127.0.0.1`, `::1`, and `localhost` are accepted while `0.0.0.0`, `192.168.1.20`, and arbitrary hostnames are rejected. Retain the server assertion that the bridge runtime receives the service key.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/config-schema.test.ts tests/unit/routes/ollama-settings.test.ts tests/unit/ollama/server.test.ts`

Expected: non-loopback hosts currently parse and save successfully.

- [ ] **Step 3: Implement loopback validation**

Add a shared pure predicate in the Ollama settings module or schema module:

```ts
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
```

Use it in the Zod schema and the admin update route so invalid runtime updates return 400 rather than being persisted. Do not change `proxyApiKey: config.server.proxy_api_key` in `startOllamaBridge()`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/config-schema.test.ts tests/unit/routes/ollama-settings.test.ts tests/unit/ollama/server.test.ts`

Expected: all selected tests pass and service-key forwarding remains intact.

- [ ] **Step 5: Commit the Ollama safety slice**

```bash
git add src/config-schema.ts src/routes/admin/ollama.ts tests/unit/config-schema.test.ts tests/unit/routes/ollama-settings.test.ts tests/unit/ollama/server.test.ts
git commit -m "fix(ollama): require a loopback listener"
```

### Task 7: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `API.md`
- Modify: `API_CN.md`
- Modify: `docker-compose.yml`
- Modify: `src/index.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Documents `server.proxy_api_key` as service-only with default `pwd`.
- Documents `dashboard.admin_key` as mandatory, generated, non-readable management-only credential.

- [ ] **Step 1: Update operator-facing documentation and startup labels**

Document strict migration, the one-time generated administration key, localhost login, environment variables, service/admin route separation, session revocation on admin rotation, and the Ollama loopback restriction in both languages. Replace ambiguous startup `Key:` output with `Service API key:`. Remove Docker comments that suggest exposing the unauthenticated Ollama bridge beyond loopback.

- [ ] **Step 2: Run secret/coupling static scans**

Run:

```bash
rg -n 'config\.server\.proxy_api_key' src/middleware src/routes/dashboard-login.ts src/routes/models.ts
rg -n 'Authorization.*apiKey|Bearer.*apiKey' shared/hooks web/src
rg -n 'admin_key' src shared web config README.md README_EN.md API.md API_CN.md
```

Expected: no management middleware/login/model-refresh references to `server.proxy_api_key`; no management hook constructs a service Bearer; administration-key references never serialize its value in GET/status responses.

- [ ] **Step 3: Run targeted backend and frontend suites**

Run:

```bash
npx vitest run tests/unit/auth/route-auth-policy.test.ts tests/unit/middleware/dashboard-auth.test.ts tests/unit/middleware/admin-mutation-guard.test.ts tests/unit/routes/dashboard-login.test.ts tests/unit/routes/service-admin-key-isolation.test.ts tests/unit/routes/ollama-settings.test.ts tests/unit/ollama/server.test.ts tests/integration/error-logs-dashboard-auth.test.ts
npm run test:web
```

Expected: zero failures.

- [ ] **Step 4: Run type checking and production build**

Run:

```bash
npx tsc --noEmit
npm run build
```

Expected: both commands exit 0 without TypeScript or Vite errors.

- [ ] **Step 5: Run the full relevant regression suite**

Run: `npm test`

Expected: zero test failures. If unrelated pre-existing dirty-worktree failures occur, record the exact failing tests and prove all task-targeted suites remain green.

- [ ] **Step 6: Review the final diff and commit documentation**

```bash
git diff --check
git status --short
git add README.md README_EN.md API.md API_CN.md docker-compose.yml src/index.ts CHANGELOG.md
git commit -m "docs: explain service and dashboard credentials"
```

Verify that only task files were staged and that unrelated user changes remain untouched.

