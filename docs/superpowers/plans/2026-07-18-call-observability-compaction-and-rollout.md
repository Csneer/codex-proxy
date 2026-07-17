# Call Observability Compaction and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim the legacy raw-JSON database space through a validated shadow copy and controlled pre-listen cutover, while exposing explicit maintenance operations, rollback evidence, and production verification.

**Architecture:** Build a compact shadow database online from the validated v2 semantic schema, but never swap it while proxy traffic is accepted. On the next controlled restart, checkpoint the live WAL, replay rows after the saved high-water mark, validate both databases, close all connections, atomically rename, reopen and verify before `serve()` is called. Failure restores/opens the rollback database and leaves proxy availability ahead of compaction.

**Tech Stack:** TypeScript, Node filesystem APIs, better-sqlite3, Hono, Preact settings UI, Vitest, systemd/service smoke checks.

**Prerequisites:** Complete the data foundation, Web shell/theme, and observability dashboard plans. Confirm semantic backfill is complete, every legacy row has a projection status, and the approved migration report passes. Execute in a dedicated worktree. Never test cutover against the only copy of the user's live database.

---

## File structure

- Create `src/call-records/compaction.ts`: shadow build, high-water delta replay, validation, closed-connection swap, rollback.
- Create `src/call-records/migration-report.ts`: deterministic before/after validation report.
- Create `src/call-records/maintenance.ts`: maintenance state and orchestration independent of HTTP.
- Create `src/routes/admin/call-record-maintenance.ts`: state, prepare, raw-clear, rebuild, full-clear, rollback-delete endpoints.
- Create `scripts/call-records-maintenance.ts`: offline/pre-listen command entry used by service startup and operators.
- Modify `src/call-records/service.ts`: expose close/reopen/maintenance state without leaking database handles.
- Modify `src/index.ts`: run pending cutover before route/server initialization and listening.
- Modify `src/routes/web.ts`: mount maintenance routes.
- Modify `web/src/components/GeneralSettings.tsx`: explicit maintenance controls and reports.
- Create `tests/integration/call-records-compaction.test.ts`: real SQLite file-copy/cutover/rollback tests.

### Task 1: Produce a deterministic migration validation report

**Files:**
- Create: `src/call-records/migration-report.ts`
- Create: `tests/unit/call-records/migration-report.test.ts`
- Modify: `src/call-records/store.ts`
- Modify: `src/call-records/raw-store.ts`

- [ ] **Step 1: Write failing matching and mismatch tests**

```ts
it("passes only when stable metadata and searchable rows match", () => {
  const report = compareMigrationSnapshots(snapshot(), snapshot());
  expect(report.status).toBe("pass");
  expect(report.checks.every((check) => check.passed)).toBe(true);
});

it("names the exact failed invariant", () => {
  const after = snapshot();
  after.tokenSums.input += 1;
  const report = compareMigrationSnapshots(snapshot(), after);
  expect(report.status).toBe("fail");
  expect(report.checks).toContainEqual(expect.objectContaining({ name: "input_tokens", passed: false }));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/unit/call-records/migration-report.test.ts`

Expected: FAIL because snapshot/report functions do not exist.

- [ ] **Step 3: Implement the exact snapshot contract**

```ts
export interface CallRecordMigrationSnapshot {
  rowCount: number;
  uniqueRequestCount: number;
  contextCount: number;
  contextMembershipHash: string;
  tokenSums: { input: number; output: number; cached: number; reasoning: number };
  firstCompletedAt: string | null;
  lastCompletedAt: string | null;
  maxSourceRowId: number;
  projection: { complete: number; partial: number; failed: number };
  searchableRows: number;
  ftsRows: number;
  integrity: "ok" | string;
}
```

`captureMigrationSnapshot()` uses sorted context/call membership to produce SHA-256, includes `PRAGMA integrity_check`, and never reads body content into the report. `compareMigrationSnapshots()` requires equality for stable fields and separately reports physical/logical bytes as informational differences.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/unit/call-records/migration-report.test.ts tests/unit/call-records/store.test.ts tests/unit/call-records/raw-store.test.ts`

Expected: PASS.

```bash
git add src/call-records/migration-report.ts src/call-records/store.ts src/call-records/raw-store.ts tests/unit/call-records/migration-report.test.ts
git commit -m "Define the evidence required before replacing call history storage" \
  -m "Constraint: Content bodies stay private; validation compares identities, aggregates, projection counts and integrity." \
  -m "Confidence: high" -m "Scope-risk: narrow" \
  -m "Tested: Matching snapshots, every mismatch class, deterministic membership hash, integrity result." \
  -m "Not-tested: Shadow copying begins in the next task."
```

### Task 2: Build a compact shadow database without touching the live file

**Files:**
- Create: `src/call-records/compaction.ts`
- Create: `tests/unit/call-records/compaction.test.ts`
- Modify: `src/call-records/store.ts`

- [ ] **Step 1: Write failing shadow-build tests**

```ts
it("builds only the compact v2 schema and records the live high-water mark", () => {
  const result = prepareCompactShadow({ livePath, shadowPath });
  expect(result.highWaterRowId).toBe(legacyMaxRowId);
  expect(readColumns(shadowPath, "call_records")).not.toContain("request_json");
  expect(readColumns(shadowPath, "call_records")).not.toContain("response_json");
  expect(result.report.status).toBe("pass");
});

it("never modifies or renames the live file during preparation", () => {
  const before = sha256File(livePath);
  prepareCompactShadow({ livePath, shadowPath });
  expect(sha256File(livePath)).toBe(before);
  expect(existsSync(`${livePath}.rollback`)).toBe(false);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/unit/call-records/compaction.test.ts`

Expected: FAIL because compaction functions do not exist.

- [ ] **Step 3: Implement the compact schema creator and copy transaction**

Create `openCompactCallRecordStore(shadowPath)` with the final schema from the approved spec, without legacy JSON columns. Copy contexts, compact call metadata, semantic content, outcome buckets, migration state, and rebuild semantic FTS from content. Store a manifest beside the shadow file:

```json
{
  "version": 1,
  "livePath": ".../call-records.sqlite",
  "shadowPath": ".../call-records.sqlite.compact",
  "highWaterRowId": 800,
  "preparedAt": "2026-07-18T00:00:00.000Z",
  "before": {},
  "shadow": {},
  "status": "prepared"
}
```

Write the manifest through temporary file, fsync and rename. If validation fails, keep the live file untouched, delete the invalid shadow, and write a failed report.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/unit/call-records/compaction.test.ts tests/unit/call-records/migration-report.test.ts`

Expected: PASS.

```bash
git add src/call-records/compaction.ts src/call-records/store.ts tests/unit/call-records/compaction.test.ts
git commit -m "Prepare compact storage without risking the active database" \
  -m "Constraint: Online preparation may read the live store but may never rename or mutate its schema." \
  -m "Confidence: high" -m "Scope-risk: broad" \
  -m "Tested: Compact schema, copy coverage, high-water manifest, failed-validation cleanup, unchanged live hash." \
  -m "Not-tested: Pre-listen delta replay and swap follow next."
```

### Task 3: Implement controlled pre-listen delta replay, swap, and rollback

**Files:**
- Modify: `src/call-records/compaction.ts`
- Create: `tests/integration/call-records-compaction.test.ts`
- Modify: `src/call-records/service.ts`

- [ ] **Step 1: Write failing real-file cutover tests**

```ts
it("replays rows after the shadow high-water mark before swapping", () => {
  prepareCompactShadow({ livePath, shadowPath });
  insertLiveCall(livePath, "request-after-prepare");
  const result = cutoverCompactStore({ livePath, shadowPath, manifestPath });
  expect(result.status).toBe("swapped");
  expect(openCompact(livePath).findByRequestId("request-after-prepare")).not.toBeNull();
});

it("restores the rollback file when post-open verification fails", () => {
  corruptShadowAfterRenameHook = true;
  const result = cutoverCompactStore({ livePath, shadowPath, manifestPath });
  expect(result.status).toBe("rolled_back");
  expect(openLegacy(livePath).getAllRequestIds()).toEqual(originalRequestIds);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/integration/call-records-compaction.test.ts`

Expected: FAIL on missing cutover implementation.

- [ ] **Step 3: Implement the exact cutover sequence**

`cutoverCompactStore()` must:

1. acquire an exclusive maintenance lock file with `openSync(..., "wx")`;
2. open the live DB as sole writer and run `PRAGMA wal_checkpoint(TRUNCATE)`;
3. copy every live row where `rowid > manifest.highWaterRowId` and its semantic content, upsert every context referenced by those rows, refresh all bounded outcome buckets and migration-state rows (because an existing hour bucket may have changed after preparation), and rebuild FTS entries for the delta calls;
4. compare full snapshots and run `PRAGMA integrity_check` on both files;
5. close both SQLite handles and assert the service singleton reports closed;
6. fsync both files and their parent directory where supported;
7. rename live to `call-records.sqlite.rollback-<timestamp>` and shadow to the canonical live path;
8. reopen the canonical compact store and recapture the snapshot;
9. if verification fails, close it, rename the failed compact file aside, restore rollback to the canonical path, reopen legacy, and return `rolled_back`;
10. update/fsync the manifest and remove the maintenance lock in `finally`.

Do not use `VACUUM INTO` as the swap protocol and do not accept HTTP traffic during this function.

- [ ] **Step 4: Add crash-recovery state tests**

Cover every filesystem state: both canonical+rollback exist, canonical missing with rollback present, canonical compact present with prepared manifest, stale lock whose PID is gone, and active lock whose PID is alive. Recovery must choose the last verified canonical/rollback state and never delete the only valid database.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/integration/call-records-compaction.test.ts tests/unit/call-records/compaction.test.ts`

Expected: PASS across delta replay, rollback and crash states.

```bash
git add src/call-records/compaction.ts src/call-records/service.ts tests/integration/call-records-compaction.test.ts
git commit -m "Replace legacy storage only when no call can race the cutover" \
  -m "Constraint: Cutover runs before HTTP listen with final delta replay, closed connections, integrity checks and rollback." \
  -m "Rejected: Live atomic rename | the long-lived writer could append to the displaced inode." \
  -m "Confidence: high" -m "Scope-risk: broad" \
  -m "Directive: Never invoke cutoverCompactStore after the server begins accepting traffic." \
  -m "Tested: Real SQLite delta replay, checkpoint, swap, post-open verify, rollback and crash recovery." \
  -m "Not-tested: Startup wiring follows in the next task."
```

### Task 4: Wire maintenance into startup before HTTP listen

**Files:**
- Create: `src/call-records/maintenance.ts`
- Create: `scripts/call-records-maintenance.ts`
- Create: `tests/unit/call-records/maintenance.test.ts`
- Modify: `src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing ordering tests**

```ts
it("completes a pending cutover before serve is called", async () => {
  await startServer({ maintenance, serve: serveSpy });
  expect(maintenance.runPreListen).toHaveBeenCalledBefore(serveSpy);
});

it("starts with the rollback store after a recoverable cutover failure", async () => {
  maintenance.runPreListen.mockResolvedValue({ status: "rolled_back" });
  const server = await startServer({ maintenance, serve: serveSpy });
  expect(server).toBeDefined();
  expect(serveSpy).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/unit/call-records/maintenance.test.ts tests/unit/call-records/service.test.ts`

Expected: FAIL because startup has no maintenance injection or pre-listen phase.

- [ ] **Step 3: Add pre-listen orchestration**

At the beginning of `startServer()`, after config/data paths are known but before `initializeCallRecordService()` and route setup, call `runCallRecordPreListenMaintenance(config)`. It detects a prepared manifest and performs cutover/recovery. A failed compaction with a valid rollback logs the report and continues; no valid permanent DB degrades call recording but still lets proxy traffic start, matching existing availability policy.

Add CLI commands:

```text
npm run call-records:status
npm run call-records:prepare
npm run call-records:verify
```

The CLI emits JSON and never prepares/swaps without an explicit command.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npx vitest run tests/unit/call-records/maintenance.test.ts tests/unit/call-records/service.test.ts tests/integration/call-records-compaction.test.ts
npm run build
```

Expected: PASS; build exits 0.

```bash
git add src/call-records/maintenance.ts scripts/call-records-maintenance.ts src/index.ts package.json tests/unit/call-records/maintenance.test.ts
git commit -m "Finish call-record cutover before the proxy opens its port" \
  -m "Constraint: A recoverable observability migration failure must not prevent proxy availability." \
  -m "Confidence: high" -m "Scope-risk: broad" \
  -m "Directive: Keep maintenance before initializeCallRecordService and before serve()." \
  -m "Tested: Startup ordering, rollback startup, CLI JSON, integration cutover and production build." \
  -m "Not-tested: Admin maintenance controls follow next."
```

### Task 5: Add explicit authenticated maintenance operations

**Files:**
- Create: `src/routes/admin/call-record-maintenance.ts`
- Create: `tests/unit/routes/call-record-maintenance.test.ts`
- Modify: `src/routes/web.ts`
- Modify: `src/call-records/maintenance.ts`
- Modify: `web/src/components/GeneralSettings.tsx`
- Modify: `web/src/components/GeneralSettings.call-records.test.tsx`
- Modify: `shared/http/admin-fetch.ts`
- Modify: `shared/i18n/translations.ts`

- [ ] **Step 1: Write failing safe-operation and confirmation tests**

```ts
it("requires CSRF and an exact confirmation phrase for full clear", async () => {
  const response = await app.request("/admin/call-records/maintenance/clear-all", {
    method: "POST",
    headers: csrfHeaders,
    body: JSON.stringify({ confirm: "wrong" }),
  });
  expect(response.status).toBe(400);
  expect(maintenance.clearAll).not.toHaveBeenCalled();
});

it("preparation never swaps the active database", async () => {
  const response = await app.request("/admin/call-records/maintenance/prepare", { method: "POST", headers: csrfHeaders });
  expect(response.status).toBe(202);
  expect(maintenance.prepare).toHaveBeenCalledOnce();
  expect(maintenance.cutover).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/unit/routes/call-record-maintenance.test.ts web/src/components/GeneralSettings.call-records.test.tsx`

Expected: FAIL because maintenance routes/UI do not exist.

- [ ] **Step 3: Add guarded routes**

Add:

```text
GET  /admin/call-records/maintenance
POST /admin/call-records/maintenance/prepare
POST /admin/call-records/maintenance/rebuild-semantic
POST /admin/call-records/maintenance/clear-raw
POST /admin/call-records/maintenance/clear-all
DELETE /admin/call-records/maintenance/rollback
```

All mutations pass the shared CSRF guard. Preparation/rebuild run bounded background jobs and return 202. `clear-raw` requires `confirm: "CLEAR RAW EVIDENCE"`; `clear-all` requires `confirm: "CLEAR ALL CALL DATA"`; rollback deletion requires `confirm: "DELETE ROLLBACK"` and is refused before a verified compact store has run successfully.

- [ ] **Step 4: Add UI maintenance state and confirmations**

In General Settings, show migration/backfill/projection counts, shadow/rollback paths as basenames, last report, and separate actions. State clearly that “Prepare compact database” does not switch files and that switching occurs on restart. Never put full filesystem paths or body content into client responses.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run tests/unit/routes/call-record-maintenance.test.ts web/src/components/GeneralSettings.call-records.test.tsx tests/unit/middleware/admin-mutation-guard.test.ts
npm run test:web
```

Expected: PASS.

```bash
git add src/routes/admin/call-record-maintenance.ts src/routes/web.ts src/call-records/maintenance.ts web/src/components/GeneralSettings.tsx web/src/components/GeneralSettings.call-records.test.tsx shared/http/admin-fetch.ts shared/i18n/translations.ts tests/unit/routes/call-record-maintenance.test.ts
git commit -m "Make destructive call-history maintenance explicit and reversible" \
  -m "Constraint: Preparation never swaps live files; deletion requires exact authenticated confirmation." \
  -m "Confidence: high" -m "Scope-risk: moderate" \
  -m "Tested: CSRF, confirmation phrases, async preparation, rollback retention and Web maintenance states." \
  -m "Not-tested: Live operator approval to delete rollback remains manual."
```

### Task 6: Execute the final release verification and service rollout

**Files:**
- Modify only implementation files when a verification failure proves a defect.
- Do not delete the user's rollback database in this task.

- [ ] **Step 1: Run the complete automated suite in dependency order**

```bash
npx vitest run tests/unit/call-records tests/unit/routes/call-observability.test.ts tests/unit/routes/call-records.test.ts tests/unit/routes/call-record-maintenance.test.ts tests/unit/middleware/admin-mutation-guard.test.ts tests/integration/call-records-proxy.test.ts tests/integration/call-records-compaction.test.ts
npm run test:web
npm run build
```

Expected: zero failures and build exit 0.

- [ ] **Step 2: Rehearse migration on a disposable copy of the real database**

Copy the live permanent and raw databases into a temporary data directory. Run status → backfill → verify → prepare → controlled restart cutover. Compare:

- row and unique request counts;
- context membership hash;
- all token sums;
- first/last completion time;
- projection complete/partial/failed counts;
- semantic searchable/FTS counts;
- raw rows restricted to retention window;
- API list/context/detail stable metadata;
- before/after physical sizes.

Expected: report `pass`; compact permanent DB omits legacy JSON columns; rollback copy remains.

- [ ] **Step 3: Run authenticated browser and API smoke tests**

Bind to `0.0.0.0`, authenticate from a non-loopback client, and verify:

- dashboard login and CSRF-protected mutation;
- Today/24h/7d overview;
- context/detail/search/raw expiry;
- background upload/replace/delete and light/dark preferences;
- existing accounts, proxies, API keys, logs, errors, usage and settings workflows;
- unauthenticated remote `/admin/*` remains 401;
- malicious cross-origin mutation remains 403;
- `/v1/chat/completions` remains available throughout non-cutover operation.

- [ ] **Step 4: Re-run visual verification**

Capture the required desktop and phone screenshots and run `visual-verdict`. Require score ≥90, no console errors, no operational text below 11px, and no obvious image distortion/refraction.

- [ ] **Step 5: Prepare and perform the live cutover**

Only after Steps 1–4 pass:

1. verify free disk space for live + shadow + rollback;
2. run `npm run call-records:prepare` and save its JSON report;
3. restart the managed service once; pre-listen maintenance performs delta replay/swap;
4. poll service health and authenticated overview;
5. verify a new successful call is written to the compact store and appears in the dashboard;
6. preserve the rollback file; do not invoke rollback deletion.

Stop and restore the verified rollback if service health, row counts, integrity, or new-call persistence fails.

- [ ] **Step 6: Record final evidence**

Write a release note or commit body listing exact test counts, build output, migration report path/hash, before/after bytes, service restart evidence, smoke endpoints, visual-verdict JSON, rollback filename and retention decision. If implementation fixes were required, commit them with the Lore protocol; otherwise do not make an empty commit.

## Rollout completion gate

- The compact file contains every validated semantic row and no legacy large JSON columns.
- The final delta after online shadow preparation is present.
- All database connections were closed before rename.
- Startup verifies the compact file before listening and can restore rollback.
- One new post-cutover successful call persists and appears in overview/context/detail.
- Remote authentication and CSRF behavior remain correct on `0.0.0.0`.
- Rollback remains available until separate operator approval.
- Full automated, smoke, build and visual evidence passes.
