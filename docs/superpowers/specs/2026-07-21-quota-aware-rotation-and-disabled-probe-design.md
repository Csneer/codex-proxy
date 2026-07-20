# Quota-aware account rotation and disabled-account probe design

Date: 2026-07-21

## 1. Goal

Add two related account-pool capabilities without increasing normal upstream probe traffic:

1. A quota-aware rotation strategy that keeps using one account for a configurable quota increment, such as 20%, 30%, or 40%, and then moves new requests to the next eligible account.
2. An explicit read-only quota probe for disabled accounts that reports whether the account and its quota are usable without returning the account to the business-traffic pool.

The design keeps the existing quota refresh paths as the source of truth. It does not add a new periodic quota poller for rotation.

## 2. Current behavior and root cause

The account pool currently supports:

- `least_used`: balances by accumulated local request count, so accounts tend to converge toward request-by-request alternation.
- `round_robin`: advances on every selection.
- `sticky`: keeps selecting the most recently used eligible account.

None of these strategies creates a continuous quota-sized batch.

Quota data is already updated by two existing paths:

- response rate-limit headers from normal proxied traffic;
- existing quota refresh and manual quota-query mechanisms.

The disabled-account problem is a route-layer restriction. `CodexApi.getUsage()` only needs the account credential, account ID, cookies, TLS transport, and proxy assignment, but `GET /auth/accounts/:id/quota` currently rejects every account whose routing status is not `active`. A manually disabled account therefore returns HTTP 409 before any upstream check, and the external probe script can incorrectly classify that local routing decision as account invalidity.

## 3. Scope

### 3.1 Included

- A `quota_batch` rotation strategy.
- A configurable integer quota increment, defaulting to 30 percentage points and accepting values from 1 through 100.
- Secondary/weekly quota as the preferred meter, with primary quota as the fallback.
- A small persisted rotation checkpoint so service restarts do not silently start another full batch on the same account.
- Settings API and Web UI support for selecting the strategy and editing the increment.
- Explicit disabled-account probing through `probe_disabled=true`.
- One controlled token refresh attempt for a disabled account when the usage request proves the access token invalid and a refresh token exists.
- Structured probe outcomes and an update to the existing external probe script.
- Regression tests for selection, persistence, configuration, route behavior, token refresh locking, and status preservation.

### 3.2 Excluded

- A new high-frequency or all-account quota polling loop.
- Exact switching at the instant the configured percentage is consumed.
- Killing or moving requests already in flight.
- Automatically enabling, disabling, deleting, or logging in accounts.
- Allowing `expired`, `banned`, `refreshing`, or `quota_exhausted` accounts through the disabled probe in the first version.
- A general disabled-reason audit system.
- Replacing the existing refresh scheduler or quota-warning system.

## 4. Quota-aware rotation

### 4.1 Configuration

The authentication configuration adds:

```yaml
auth:
  rotation_strategy: quota_batch
  quota_batch_percent: 30
```

`rotation_strategy` accepts the existing values plus `quota_batch`. `quota_batch_percent` is an integer from 1 through 100 and defaults to 30. The value remains stored even while another rotation strategy is selected, so switching away and back does not lose the user's preference.

The general-settings API returns and accepts both fields. Updating the strategy at runtime resets the in-memory selection state. Updating `quota_batch_percent` while `quota_batch` is active re-baselines the current account on its next selection, rather than applying the new threshold to an older baseline.

The Web settings panel adds “Quota batch” alongside the existing rotation choices and shows a compact numeric percentage input only when that strategy is selected. The input uses the same 1–100 validation as the server and explains that weekly quota is preferred with primary fallback.

### 4.2 Effective quota meter

For an account, the effective meter is selected as follows:

1. Use `cachedQuota.secondary_rate_limit.used_percent` when it is a finite number.
2. Otherwise use `cachedQuota.rate_limit.used_percent` when it is a finite number.
3. Otherwise the effective meter is unknown.

The checkpoint records both the meter kind and its `reset_at`. A meter-kind change or reset-window change causes a re-baseline instead of an immediate switch.

This rule lets Plus/Pro accounts use the longer weekly bucket where available while retaining useful behavior for plans that only report primary quota.

### 4.3 Selection state

The strategy owns one small checkpoint:

```json
{
  "version": 1,
  "strategy": "quota_batch",
  "batchPercent": 30,
  "currentEntryId": "account-id",
  "baselineUsedPercent": 12,
  "meter": "secondary",
  "resetAt": 1780000000
}
```

It is stored under the configured data directory as `quota-rotation-state.json` using the repository's atomic JSON-write conventions. It is written only when the current account or its baseline changes, not on every request. A missing, corrupt, or incompatible file is ignored with a warning and rebuilt from current account data; account traffic must remain available.

The checkpoint contains no access token, refresh token, email address, prompt, response, or other credential/content data.

### 4.4 Selection algorithm

The normal eligibility filters remain authoritative before quota batching:

- routing status must be `active`;
- concurrency slots must be available;
- explicit retry exclusions apply;
- Cloudflare cooldown applies;
- model-plan and configured tier filtering apply;
- exhausted quota is skipped when `quota.skip_exhausted` is enabled.

After filtering:

1. If the checkpoint's current account is still a candidate, compare its effective used percentage with the recorded baseline.
2. If the meter is unknown, keep the current account and wait for the existing quota mechanisms to populate the cache.
3. If the meter, reset window, configured percentage, or quota window changed, record the current percentage as a new baseline and keep the current account.
4. If the current percentage is lower than the baseline, treat this as a quota reset or corrected upstream reading, re-baseline, and keep the current account.
5. If `current - baseline < quota_batch_percent`, keep the current account.
6. If the difference is at least the configured percentage, advance once to the next eligible account and record that account's current effective percentage as its new baseline.
7. If the current account is no longer eligible, advance immediately without waiting for the quota threshold.
8. If only one account is eligible, continue using it and re-baseline as necessary; the strategy must not make the pool unavailable.

Candidate order follows stable account-registry order and wraps at the end. This creates continuous batches rather than per-request alternation.

The comparison runs during the next account acquisition after cached quota changes. Consequently, switching is intentionally approximate: a response may take the account slightly past the threshold, and already-running requests finish on their acquired account.

### 4.5 Session affinity and retries

While `quota_batch` is active, the current batch account takes precedence over a stale conversation affinity. Otherwise a conversation bound to the previous account could permanently defeat the requested rotation. Once a threshold switch occurs, new acquisitions use the new batch account.

Retry exclusions, account unavailability, model-plan constraints, and tier constraints continue to override the batch choice. Existing retry and implicit-resume recovery remain responsible for account-scoped upstream state. No in-flight request is reassigned.

Other strategies preserve their current affinity behavior unchanged.

### 4.6 Interaction with quota refresh

Quota-aware rotation does not start, schedule, or invoke a new probe:

- normal response headers continue to update `cachedQuota`;
- the existing active quota refresher continues its current locked/dirty-account behavior;
- manual quota refresh continues to update the same cache;
- selection simply inspects the latest cached value.

This means an account with stale or unknown quota remains on its current batch until an existing mechanism supplies a usable percentage or the account becomes ineligible. This is preferable to extra risk-sensitive upstream requests.

## 5. Disabled-account quota probe

### 5.1 API compatibility

The existing request remains unchanged:

```http
GET /auth/accounts/:id/quota
```

Without the query parameter, only `active` accounts are accepted and the existing `{ quota, raw }` success response remains compatible.

Explicit probing uses:

```http
GET /auth/accounts/:id/quota?probe_disabled=true
```

The explicit form accepts `active` and `disabled` accounts. The first release rejects `expired`, `banned`, `refreshing`, and `quota_exhausted` with HTTP 409.

### 5.2 Status invariant

For an account that enters the probe as `disabled`:

- its routing status remains `disabled` during and after every success or failure path;
- it is never passed to `AccountPool.acquire()`;
- no refresh-scheduler timer is installed;
- no WebSocket or business request is opened;
- it is not automatically deleted, enabled, marked expired, or marked banned.

The probe response reports upstream evidence separately from the local routing status.

### 5.3 Probe flow

1. Load the account and save its original routing status.
2. Enforce the status admission table.
3. Call `CodexApi.getUsage()` with the existing per-account cookies, proxy assignment, and TLS transport.
4. On success, normalize the result with `toQuota()`, update `cachedQuota` and `quotaFetchedAt`, classify the quota, and return the structured result.
5. If and only if the error is a confirmed token-invalid error, the original status is `disabled`, and a refresh token exists, attempt one controlled refresh.
6. The controlled refresh uses the existing cross-process refresh lock and refresh-token rotation rules, updates the stored access/refresh tokens, preserves `disabled`, installs no scheduler timer, and retries `getUsage()` exactly once.
7. Other failures are classified and returned without status mutation.

If the refresh lock is already held or the token refresh result cannot be classified safely, the probe returns `unknown_failure`; it does not consume the same refresh token concurrently.

### 5.4 Response model

A successful explicit probe returns HTTP 200:

```json
{
  "routing_status": "disabled",
  "probe_status": "available",
  "quota_source": "live",
  "token_refreshed": false,
  "quota": {
    "plan_type": "plus",
    "rate_limit": {},
    "secondary_rate_limit": {},
    "code_review_rate_limit": null,
    "credits": null
  }
}
```

`probe_status` is one of:

- `available`: the live usage endpoint succeeded and the selected quota meter is below the configured warning threshold;
- `quota_low`: the live endpoint succeeded and the preferred meter reached the first configured warning threshold;
- `quota_exhausted`: the live endpoint succeeded and any routable quota bucket reports `limit_reached`;
- `token_invalid`: authentication is definitively invalid and the controlled refresh was unavailable or failed definitively;
- `account_banned`: the upstream response explicitly identifies deactivation or banning;
- `transient_network`: timeout, TLS EOF, connection reset, or equivalent transport failure;
- `upstream_blocked`: Cloudflare challenge or an unexpected HTML response;
- `unknown_failure`: the evidence is insufficient for a safer classification.

`quota_low` uses the first applicable existing warning threshold from `quota.warning_thresholds`: secondary when the effective meter is secondary, otherwise primary. It introduces no new warning configuration.

Upstream failures return a meaningful HTTP error status together with the same `routing_status`, `probe_status`, `quota_source: "live"`, `token_refreshed`, and a bounded error detail. Consumers must classify by `probe_status`, not by HTTP status alone.

The explicit probe does not return the raw upstream payload. The ordinary active quota endpoint retains its existing raw response for compatibility.

### 5.5 External probe consumer

`/home/devops/NewAPI/codex-proxy/probe_codex_accounts.py` will call every account through:

```text
/auth/accounts/<id>/quota?probe_disabled=true
```

It will:

- classify results from `probe_status`;
- report `routing_status` separately;
- treat `available`, `quota_low`, and `quota_exhausted` as proof that the account authenticated successfully;
- keep transient network and upstream blocking separate from permanent invalidity;
- stop interpreting local disabled HTTP 409, generic HTML, or generic 502 as proof of account invalidity;
- include `token_refreshed` in JSON and human-readable output.

The script remains a reporting consumer. It does not change account status or delete accounts.

## 6. Component boundaries

The implementation keeps responsibilities separated:

- `rotation-strategy.ts`: strategy names and stateless existing selectors.
- A focused quota-batch selector/state module: effective-meter calculation, threshold decision, checkpoint load/save, and next-candidate selection.
- `account-lifecycle.ts`: existing eligibility filtering and strategy dispatch; it gives quota batching the already-filtered candidates.
- Configuration/settings/UI: validation and user-editable strategy/percentage only.
- A focused account-quota probe service: admission, live usage request, one controlled refresh, classification, and response construction.
- `accounts.ts`: HTTP parsing and status-code rendering only.
- External probe script: consumes the structured result without duplicating server-side account validity rules.

No new dependency is required.

## 7. Error handling and recovery

- Corrupt rotation state is non-fatal and rebuilt.
- Missing quota data keeps the current account instead of falling back to per-request rotation.
- Quota decreases or window changes re-baseline instead of causing repeated switches.
- Candidate disappearance advances to the next eligible candidate.
- A disabled probe never changes routing status, including token-invalid and banned results.
- Token refresh is attempted at most once and only under the existing cross-process lock.
- Transport and Cloudflare failures are not promoted to permanent account failure.
- All externally returned error details are length-bounded and contain no token or cookie values.

## 8. Test strategy

### 8.1 Quota-aware rotation

Tests will prove:

- secondary quota is preferred and primary quota is the fallback;
- 20%, 30%, and 40% increments are accepted;
- an account is reused below the threshold and switched at or above it;
- switching is based on percentage-point delta from the recorded baseline, not absolute usage;
- unknown quota does not cause request-by-request rotation;
- reset, percentage decrease, meter change, and settings change re-baseline;
- disabled, exhausted, excluded, cooldown, wrong-plan, and saturated accounts remain ineligible;
- stable wraparound order works;
- one eligible account remains usable;
- batch selection overrides stale affinity while other strategies retain current affinity behavior;
- checkpoint persistence survives restart and corrupt state fails open safely;
- concurrent acquisitions do not move already-acquired requests.

### 8.2 Disabled probe

Tests will prove:

- ordinary quota requests still reject disabled accounts;
- explicit probes accept active and disabled but reject other states;
- disabled success updates quota while preserving status;
- confirmed access-token invalidity performs no more than one locked refresh and one retry;
- rotated refresh tokens are persisted and no scheduler timer is installed;
- disabled status is preserved for success, invalid token, ban, network, Cloudflare, lock contention, and unknown errors;
- error classification distinguishes every documented `probe_status`;
- responses do not expose raw upstream payloads, credentials, or cookies;
- the external probe script consumes structured results correctly.

### 8.3 Verification

Completion requires targeted unit and route tests, Web component tests, TypeScript typecheck, production Web/server build, full repository tests with any pre-existing unrelated baseline failure identified explicitly, and a local runtime smoke test before updating the actual service.

## 9. Acceptance criteria

The feature is complete when:

1. A user can select quota-batch rotation and enter a percentage such as 20, 30, or 40.
2. The same eligible account handles consecutive requests until its cached effective quota increases by approximately that many percentage points.
3. The next acquisition switches to the next eligible account without adding any new quota polling loop.
4. A disabled account can be explicitly probed for live quota and remains disabled on every outcome.
5. A disabled account with an invalid access token can perform at most one safe refresh/retry while preserving routing status.
6. The external probe output distinguishes routing status, authenticated-but-low/exhausted quota, permanent authentication failure, transient network failure, and upstream blocking.
7. Existing rotation strategies and ordinary active quota API clients remain behaviorally compatible.
