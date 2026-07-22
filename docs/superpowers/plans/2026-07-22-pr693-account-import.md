# PR #693 Account Identity Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely import accountId-less Sub2API credentials through authoritative, proxy-aware identity discovery.

**Architecture:** Add pure token-metadata and identity-response parsers around one proxy-aware discovery service. Integrate them into the existing import pipeline and account registry without replacing local scheduling, quota probing, or persistence behavior.

**Tech Stack:** TypeScript, Hono, Preact, Vitest, existing TLS transport and account persistence.

---

### Task 1: Lock transfer and UI behavior

**Files:**
- Modify: `tests/unit/services/account-transfer-formats.test.ts`
- Modify: `web/src/components/AccountImportExport.test.tsx`

- [x] Add upstream regression cases for portable identity hints and concrete import errors.
- [x] Run both tests and confirm they fail for missing behavior.

### Task 2: Add token metadata and identity discovery

**Files:**
- Create: `src/auth/token-metadata.ts`
- Create: `src/services/account-identity-resolver.ts`
- Modify: `src/auth/chatgpt-oauth.ts`
- Test: `tests/unit/auth/chatgpt-oauth.test.ts`
- Test: `tests/unit/auth/jwt-utils.test.ts`
- Test: `tests/unit/services/account-identity-resolver.test.ts`

- [x] Add upstream parser and discovery tests and verify RED.
- [x] Implement metadata precedence and proxy-aware authenticated discovery.
- [x] Run the focused tests and verify GREEN.

### Task 3: Persist resolved identity metadata

**Files:**
- Modify: `src/auth/types.ts`
- Modify: `src/auth/account-registry.ts`
- Modify: `src/auth/account-pool.ts`
- Modify: `src/auth/account-persistence.ts`
- Modify: `src/auth/oauth-pkce.ts`

- [x] Extend account types with optional organization/source fields.
- [x] Pass resolved metadata through pool and registry while retaining token-derived fallbacks.
- [x] Normalize old account files and preserve new fields across refresh.

### Task 4: Integrate account import and formats

**Files:**
- Modify: `src/services/account-import.ts`
- Modify: `src/services/account-transfer-formats.ts`
- Modify: `src/routes/accounts.ts`
- Test: `tests/unit/services/account-import.test.ts`
- Test: `tests/unit/services/account-transfer-formats.test.ts`
- Test: `tests/unit/routes/accounts-import-export.test.ts`

- [x] Add service and route regression tests and verify RED.
- [x] Invoke discovery only for structurally valid accountId-less credentials.
- [x] Route discovery through the runtime proxy, redact errors, and verify GREEN.

### Task 5: Improve import error presentation

**Files:**
- Modify: `web/src/components/AccountImportExport.tsx`
- Test: `web/src/components/AccountImportExport.test.tsx`

- [x] Append the first concrete import error to the aggregate result.
- [x] Run the component test and verify GREEN.

### Task 6: Verify compatibility and #692 coverage

**Files:**
- Inspect: `src/config-schema.ts`
- Inspect: `src/ollama/bridge.ts`
- Inspect: `tests/unit/config-schema.test.ts`
- Inspect: `tests/unit/ollama/bridge.test.ts`

- [x] Run focused backend and frontend tests.
- [x] Run typecheck/build and the relevant account/quota regression suite.
- [x] Confirm #692 has no missing behavior and avoid duplicate edits.
- [x] Review the final diff for credential exposure and local-feature regressions.

## Verification record

- Focused account import, resolver, transfer, routes, pool, quota batching, and quota probe: 157 tests passed.
- Frontend: 55 tests passed; production build passed.
- Backend TypeScript build and script typecheck passed.
- Full backend suite: 2810 tests passed, 1 skipped, using one worker and a 10-second per-test budget to avoid the repository's parallel 5-second timeout noise.
