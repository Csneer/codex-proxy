# Quota-aware Rotation and Disabled Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add continuous, quota-percentage account batches and safe live quota probing for disabled accounts without introducing a new quota polling loop.

**Architecture:** Existing account eligibility filtering remains in `AccountLifecycle`; a focused `QuotaBatchSelector` receives only eligible candidates, reads existing cached quota, and persists a credential-free checkpoint. A separate `AccountQuotaProbeService` owns status admission, live usage, one locked token refresh, and structured classification, while routes and UI remain thin adapters.

**Tech Stack:** TypeScript, Hono, Zod, Preact, Vitest, YAML configuration, atomic JSON file persistence, Python standard library.

---

## File map

- Create `src/auth/quota-batch-selector.ts`: effective quota meter, checkpoint validation/persistence, threshold selection.
- Create `src/services/account-quota-probe.ts`: disabled-safe live probe, refresh locking, result classification.
- Create `tests/unit/auth/quota-batch-selector.test.ts`: selector and persistence behavior.
- Create `tests/unit/services/account-quota-probe.test.ts`: probe classification and state invariants.
- Create `web/src/components/RotationSettings.test.tsx`: quota-batch settings interaction.
- Modify `src/config-schema.ts`, `config/default.yaml`, `tests/_helpers/config.ts`, `tests/unit/config-schema.test.ts`: configuration contract.
- Modify `src/auth/rotation-strategy.ts`, `src/auth/account-lifecycle.ts`, `src/auth/account-pool.ts`: strategy dispatch and runtime reset.
- Modify `src/routes/admin/settings.ts`, `tests/unit/routes/general-settings.test.ts`: settings API.
- Modify `src/routes/accounts.ts`, `tests/unit/routes/accounts-import-export.test.ts`: probe HTTP adapter and compatibility.
- Modify `shared/hooks/use-rotation-settings.ts`, `web/src/components/RotationSettings.tsx`, `shared/i18n/translations.ts`: Web settings.
- Modify `/home/devops/NewAPI/codex-proxy/probe_codex_accounts.py`: structured probe consumer outside the repository.
- Modify `CHANGELOG.md`: user-visible behavior.

### Task 1: Configuration and settings contract

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `config/default.yaml`
- Modify: `tests/_helpers/config.ts`
- Modify: `src/routes/admin/settings.ts`
- Test: `tests/unit/config-schema.test.ts`
- Test: `tests/unit/routes/general-settings.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add assertions that `ROTATION_STRATEGIES` includes `quota_batch`, default parsing yields `auth.quota_batch_percent === 30`, and values `20`, `30`, and `40` parse while `0`, `101`, and non-integers fail.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/config-schema.test.ts
```

Expected: failure because `quota_batch` and `quota_batch_percent` are absent.

- [ ] **Step 3: Implement the schema and defaults**

Change the strategy tuple to:

```ts
export const ROTATION_STRATEGIES = ["least_used", "round_robin", "sticky", "quota_batch"] as const;
```

Add to the auth schema and default YAML:

```ts
quota_batch_percent: z.number().int().min(1).max(100).default(30),
```

```yaml
quota_batch_percent: 30
```

Update `createMockConfig()` so every test receives the complete field.

- [ ] **Step 4: Write failing settings-route tests**

Prove GET returns both fields, POST persists both fields, POST preserves the existing percentage when only the strategy changes, and invalid percentage values return HTTP 400 without calling `mutateYaml`.

- [ ] **Step 5: Verify RED**

Run:

```bash
npx vitest run tests/unit/routes/general-settings.test.ts
```

Expected: route responses omit `quota_batch_percent` and validation is missing.

- [ ] **Step 6: Implement the settings adapter**

Accept this body shape:

```ts
{
  rotation_strategy?: string;
  quota_batch_percent?: number;
}
```

Require at least one supplied field, validate each independently, atomically mutate only supplied keys under `auth`, reload config, and return both current values.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npx vitest run tests/unit/config-schema.test.ts tests/unit/routes/general-settings.test.ts
npx tsc --noEmit
git diff --check
```

Commit with a Lore message whose intent is to expose a bounded quota-batch configuration contract.

### Task 2: Quota batch selector and lifecycle integration

**Files:**
- Create: `src/auth/quota-batch-selector.ts`
- Create: `tests/unit/auth/quota-batch-selector.test.ts`
- Modify: `src/auth/rotation-strategy.ts`
- Modify: `src/auth/account-lifecycle.ts`
- Modify: `src/auth/account-pool.ts`
- Test: `tests/unit/auth/account-pool-config-di.test.ts`
- Test: `tests/unit/auth/account-pool-sticky.test.ts`
- Test: `tests/integration/account-routing.test.ts`

- [ ] **Step 1: Write failing effective-meter tests**

Use real `AccountEntry` fixtures to prove the wished-for API:

```ts
effectiveQuotaMeter(entry)
```

returns secondary when finite, primary as fallback, and `null` when neither is finite. Verify returned objects contain `kind`, `usedPercent`, and `resetAt`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/auth/quota-batch-selector.test.ts
```

Expected: module or export not found.

- [ ] **Step 3: Implement meter and checkpoint store**

Define:

```ts
type QuotaMeterKind = "secondary" | "primary";
interface QuotaBatchCheckpoint {
  version: 1;
  strategy: "quota_batch";
  batchPercent: number;
  currentEntryId: string;
  baselineUsedPercent: number | null;
  meter: QuotaMeterKind | null;
  resetAt: number | null;
}
```

Implement strict runtime validation, `getDataDir()/quota-rotation-state.json`, temp-file plus rename persistence, missing-file behavior, and corrupt-file warning/fail-open behavior. Do not persist any credential or content field.

- [ ] **Step 4: Write failing selector behavior tests**

Cover these independent cases:

- initial selection establishes a baseline;
- the selected account repeats below a 20/30/40-point delta;
- reaching the delta advances once and wraps stably;
- absolute 30% does not switch when the baseline was 20%;
- unknown quota stays on the same account;
- used-percent decrease, reset change, meter change, or percentage change re-baselines;
- an ineligible current account advances immediately;
- one candidate remains usable;
- persisted state survives a new selector instance;
- corrupt state is ignored.

- [ ] **Step 5: Verify RED and implement minimal selector**

Run the selector tests and confirm threshold cases fail, then implement:

```ts
select(candidates: AccountEntry[], batchPercent: number): AccountEntry
reset(): void
```

Maintain stable candidate order, choose the candidate after the previous account when advancing, and persist only when the checkpoint changes.

- [ ] **Step 6: Write failing lifecycle integration tests**

Construct `AccountPool` with `quota_batch`, update cached quota through `pool.updateCachedQuota`, and prove:

- consecutive acquisitions keep one account until the cached delta reaches the configured value;
- the next acquisition switches;
- stale `preferredEntryId` cannot override the active batch;
- retry `excludeIds`, model-plan filters, tier filters, quota exhaustion, concurrency limits, and disabled status still filter candidates first;
- `least_used`, `round_robin`, and `sticky` remain unchanged.

- [ ] **Step 7: Verify RED and integrate**

Add `quota_batch` to `RotationStrategyName`, but dispatch it through `AccountLifecycle` after candidate filtering rather than forcing the stateless strategy interface to own persistence. `AccountPool.setRotationStrategy()` and a new percentage update path reset or re-baseline selector state as specified.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
npx vitest run \
  tests/unit/auth/quota-batch-selector.test.ts \
  tests/unit/auth/account-pool-config-di.test.ts \
  tests/unit/auth/account-pool-sticky.test.ts \
  tests/integration/account-routing.test.ts
npx tsc --noEmit
git diff --check
```

Commit with a Lore message whose intent is to keep account traffic continuous until cached quota crosses a configured delta.

### Task 3: Disabled-safe quota probe service and route

**Files:**
- Create: `src/services/account-quota-probe.ts`
- Create: `tests/unit/services/account-quota-probe.test.ts`
- Modify: `src/routes/accounts.ts`
- Modify: `tests/unit/routes/accounts-import-export.test.ts`
- Reuse: `src/auth/refresh-lock.ts`
- Reuse: `src/proxy/error-classification.ts`

- [ ] **Step 1: Write failing classification tests**

Define the wished-for service result:

```ts
type AccountProbeStatus =
  | "available" | "quota_low" | "quota_exhausted"
  | "token_invalid" | "account_banned"
  | "transient_network" | "upstream_blocked" | "unknown_failure";
```

Test live quota classification using existing warning thresholds and error classification for 401, explicit non-CF 403, CF challenge/HTML, TLS EOF, timeout, connection reset, and unknown failures.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/services/account-quota-probe.test.ts
```

Expected: service module not found.

- [ ] **Step 3: Implement classification and success path**

Inject dependencies for `getUsage`, `refreshAccessToken`, lock acquire/release, and proxy lookup. On successful usage, call `toQuota`, update the pool cache, classify exhausted before low, and return no raw upstream body.

- [ ] **Step 4: Write failing disabled refresh-invariant tests**

Prove all of the following:

- disabled success remains disabled;
- a confirmed 401 with a refresh token acquires the existing lock, rotates tokens, retries usage once, and remains disabled;
- no `scheduler.scheduleOne()` call exists in this service path;
- lock contention consumes no refresh token;
- refresh failure, ban, network, CF, and unknown errors preserve disabled;
- usage is attempted at most twice and refresh at most once;
- error details are bounded and redact known token values.

- [ ] **Step 5: Verify RED and implement controlled refresh**

Use `tryAcquireRefreshLock`/`releaseRefreshLock` in `try/finally`, check the latest entry again after locking, call the existing `refreshAccessToken`, update tokens through `pool.updateToken`, retry usage exactly once, and never call `markStatus` for an originally disabled entry.

- [ ] **Step 6: Write failing route compatibility tests**

Prove:

- ordinary `/quota` still rejects disabled with 409 and retains `{ quota, raw }` for active success;
- `?probe_disabled=true` accepts active and disabled;
- it rejects expired, banned, refreshing, and quota_exhausted with 409;
- explicit responses contain `routing_status`, `probe_status`, `quota_source`, `token_refreshed`, and optional `quota/detail`, but never `raw`;
- disabled status remains unchanged after every route outcome.

- [ ] **Step 7: Verify RED and implement the route adapter**

Parse the flag strictly as `=== "true"`. Keep the legacy branch untouched for requests without the flag. Delegate the explicit branch to `AccountQuotaProbeService` and map documented outcomes to HTTP status without inferring validity from status alone.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
npx vitest run \
  tests/unit/services/account-quota-probe.test.ts \
  tests/unit/routes/accounts-import-export.test.ts \
  tests/unit/auth/refresh-lock.test.ts
npx tsc --noEmit
git diff --check
```

Commit with a Lore message whose intent is to separate routing disablement from upstream account health.

### Task 4: Web settings and external probe consumer

**Files:**
- Modify: `shared/hooks/use-rotation-settings.ts`
- Modify: `web/src/components/RotationSettings.tsx`
- Create: `web/src/components/RotationSettings.test.tsx`
- Modify: `shared/i18n/translations.ts`
- Modify: `/home/devops/NewAPI/codex-proxy/probe_codex_accounts.py`
- Create outside repo if absent: `/home/devops/NewAPI/codex-proxy/test_probe_codex_accounts.py`

- [ ] **Step 1: Write failing Web tests**

Mock the settings hook/fetch path and prove quota batch appears as a rotation sub-strategy, selecting it reveals a number input, 20/30/40 are saveable, invalid values disable save or render an error, and the save payload includes both fields.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd web && npx vitest run src/components/RotationSettings.test.tsx
```

Expected: quota-batch controls do not exist.

- [ ] **Step 3: Implement hook, UI, and translations**

Extend the shared type and response state:

```ts
export type RotationStrategy = "least_used" | "round_robin" | "sticky" | "quota_batch";
interface RotationSettingsData {
  rotation_strategy: RotationStrategy;
  quota_batch_percent: number;
}
```

Add compact English and Chinese labels explaining “weekly quota first, primary fallback; switch after approximately this additional usage.” Preserve the existing collapsed layout and styling.

- [ ] **Step 4: Write failing Python consumer tests**

Using `unittest` and mocked `urllib.request.urlopen`, prove the script requests `probe_disabled=true`, maps `available`, `quota_low`, and `quota_exhausted` to authenticated results, retains routing status/token-refreshed fields, and keeps transient/upstream-blocked/permanent-invalid categories distinct.

- [ ] **Step 5: Verify RED and update the script**

Run:

```bash
python3 -m unittest /home/devops/NewAPI/codex-proxy/test_probe_codex_accounts.py
```

Expected: URL and structured classifications are absent. Implement consumption of `probe_status`; do not add status mutation or deletion.

- [ ] **Step 6: Verify GREEN and commit repository changes**

Run:

```bash
npm run test:web
python3 -m unittest /home/devops/NewAPI/codex-proxy/test_probe_codex_accounts.py
npx tsc --noEmit
git diff --check
```

Commit repository UI/i18n changes with a Lore message. The external script is not part of this Git repository; report its exact path and test result separately.

### Task 5: Integrated verification, review, merge, and rollout

**Files:**
- Modify: `CHANGELOG.md`
- Verify: all changed repository files and the external script.

- [ ] **Step 1: Add release note**

Document quota-batch rotation, existing-refresh reuse, and disabled-safe structured probing without overstating exact threshold timing.

- [ ] **Step 2: Run targeted verification**

```bash
npx vitest run \
  tests/unit/config-schema.test.ts \
  tests/unit/routes/general-settings.test.ts \
  tests/unit/auth/quota-batch-selector.test.ts \
  tests/unit/auth/account-pool-config-di.test.ts \
  tests/unit/auth/account-pool-sticky.test.ts \
  tests/integration/account-routing.test.ts \
  tests/unit/services/account-quota-probe.test.ts \
  tests/unit/routes/accounts-import-export.test.ts \
  tests/unit/auth/refresh-lock.test.ts
npm run test:web
python3 -m unittest /home/devops/NewAPI/codex-proxy/test_probe_codex_accounts.py
npx tsc --noEmit
npm run build
git diff --check
```

- [ ] **Step 3: Run full regression suite**

Rebuild `better-sqlite3` if required, then run the full Vitest suite single-threaded. Record any pre-existing unrelated baseline failure separately; do not hide new failures.

- [ ] **Step 4: Perform spec and code-quality reviews**

Review the complete diff against the design acceptance criteria, then review security properties: no tokens in checkpoint/probe output, disabled status preservation, one refresh attempt, lock release, and no new quota polling path. Fix all critical and important findings and rerun affected tests.

- [ ] **Step 5: Commit final integration**

Commit changelog and any review fixes with the Lore protocol, including exact tested and not-tested evidence.

- [ ] **Step 6: Merge into `dev` while preserving local runtime edits**

Cherry-pick the feature commits into `/home/devops/projects/codex-proxy-src`. Preserve the root worktree's user-maintained `config/default.yaml` fingerprint values, `data-source`, screenshots, backups, and all unrelated untracked files.

- [ ] **Step 7: Build and update the actual service**

```bash
npm run build
systemctl --user restart codex-proxy-source.service
systemctl --user is-active codex-proxy-source.service
ss -ltnp | rg ':8080\\b'
curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/
curl -sS -o /dev/null -w '%{http_code}\\n' http://192.168.20.60:8080/
```

Use authenticated local dashboard access to verify rotation settings load/save and probe one intentionally disabled account without changing its status. Do not expose credentials in logs or the final report.

- [ ] **Step 8: Push the personal remote**

After merged verification, push only `dev` to `personal`, confirm the remote SHA matches local HEAD, and do not push to upstream `origin`.
