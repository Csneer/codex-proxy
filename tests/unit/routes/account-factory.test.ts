import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { AccountFactoryPromotionError } from "@src/backup-resources/store.js";
import type { AccountFactoryPromotion } from "@src/backup-resources/types.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";
import { createAccountFactoryRoutes } from "@src/routes/account-factory.js";
import {
  MailDashboardError,
  type MailDashboardClient,
} from "@src/services/mail-dashboard-client.js";

const stores: BackupResourceStore[] = [];
const tempDirs: string[] = [];

function createStore(): BackupResourceStore {
  const dir = mkdtempSync(join(tmpdir(), "account-factory-routes-"));
  tempDirs.push(dir);
  const store = new BackupResourceStore(join(dir, "backup-resources.sqlite"), createTestCipher());
  stores.push(store);
  return store;
}

function createApp(
  store: BackupResourceStore,
  mail: Partial<MailDashboardClient> = {},
  promote?: (accountId: string, input: {
    schemaVersion: 1;
    idempotencyKey: string;
    expectedRevision: number;
    allowEphemeral: boolean;
  }) => Promise<AccountFactoryPromotion>,
  syncCredentials?: (input: {
    email: string;
    accessToken: string;
    refreshToken?: string | null;
    session?: string | Record<string, unknown> | null;
  }) => { email: string; coreAccountId: string | null; backupAccountIds: string[] },
) {
  return createAccountFactoryRoutes({
    resolveStore: () => store,
    resolveMailClient: () => ({
      listMailboxes: async () => [],
      pollVerificationCode: async () => ({ status: "pending" as const }),
      ...mail,
    }),
    ...(promote ? { resolvePromotionService: () => ({ promote }) } : {}),
    ...(syncCredentials ? { resolveCredentialSync: syncCredentials } : {}),
  });
}

function sync(store: BackupResourceStore) {
  return store.syncSourceAccount({
    sourceSystem: "mail_dashboard",
    externalId: "mailbox-1",
    email: "mailbox@example.com",
    sourceRevision: "revision-1",
  });
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("account-factory v1 routes", () => {
  it("syncs credentials through the registered lifecycle endpoint", async () => {
    const store = createStore();
    let received: unknown;
    const app = createApp(store, {}, undefined, (input) => {
      received = input;
      return { email: input.email, coreAccountId: "core-1", backupAccountIds: ["backup-1"] };
    });

    const response = await app.request("/integration/account-factory/v1/credentials/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "registered@example.com",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        session: "session-token",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      email: "registered@example.com",
      coreAccountId: "core-1",
      backupAccountIds: ["backup-1"],
    });
    expect(received).toEqual({
      email: "registered@example.com",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      session: "session-token",
    });
  });

  it("returns capability health and rejects malformed claims", async () => {
    const store = createStore();
    sync(store);
    const app = createApp(store);

    const health = await app.request("/integration/account-factory/v1/health");
    const invalid = await app.request("/integration/account-factory/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumerId: "consumer" }),
    });

    expect(await health.json()).toEqual({
      enabled: true,
      schemaVersion: 1,
      capabilities: ["claim", "claimRecovery", "candidateSelection", "submissionCommit", "poll", "progress", "syncState", "complete", "evidence", "fail", "promote", "credentialSync"],
      inventory: { total: 1, available: 1, mailDashboardAvailable: 1 },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_request" });
  });

  it("returns random strict candidates and claims only from selected accounts", async () => {
    const store = createStore();
    const first = sync(store);
    const second = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mailbox-2",
      email: "mailbox-2@example.com",
      sourceRevision: "revision-2",
    });
    store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mailbox-blocked",
      email: "blocked@example.com",
      sourceRevision: "blocked",
      registrationEligible: false,
    });
    const app = createApp(store);

    const candidates = await app.request("/integration/account-factory/v1/candidates?limit=10");
    expect(candidates.status).toBe(200);
    expect(candidates.headers.get("cache-control")).toBe("no-store");
    expect((await candidates.json()).accounts.map((account: { id: string }) => account.id).sort())
      .toEqual([first.id, second.id].sort());

    const selected = await app.request("/integration/account-factory/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumerId: "consumer", taskId: "selected-task", selectedAccountIds: [second.id] }),
    });
    expect(selected.status).toBe(201);
    expect(await selected.json()).toMatchObject({ account: { id: second.id } });

    const unavailable = await app.request("/integration/account-factory/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumerId: "consumer", taskId: "selected-missing", selectedAccountIds: ["missing"] }),
    });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({ error: "selected_inventory_unavailable" });
  });

  it("recovers an existing claim by task id without claiming new inventory", async () => {
    const store = createStore();
    const account = sync(store);
    const untouched = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mailbox-recovery-spare",
      email: "mailbox-recovery-spare@example.com",
      sourceRevision: "revision-recovery-spare",
    });
    const claim = store.claimAccount({
      consumerId: "consumer",
      taskId: "task-recovery",
      selectedAccountIds: [account.id],
    })!;
    const app = createApp(store);

    const recovered = await app.request(
      "/integration/account-factory/v1/claims/recovery?taskId=task-recovery",
    );
    const missing = await app.request(
      "/integration/account-factory/v1/claims/recovery?taskId=task-without-lease",
    );

    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("cache-control")).toBe("no-store");
    expect(await recovered.json()).toMatchObject({
      replayed: true,
      account: { id: account.id, email: account.email },
      lease: { id: claim.lease.id, taskId: "task-recovery" },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(store.listClaimableAccounts(10).map((item) => item.id)).toEqual([untouched.id]);
  });

  it("reconciles the mailbox snapshot after source upserts", async () => {
    const store = createStore();
    const missing = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mailbox-missing",
      email: "missing@example.com",
      sourceRevision: "revision-missing",
    });
    const app = createApp(store, {
      listMailboxes: async () => [{
        externalId: "mailbox-present",
        email: "present@example.com",
        sourceRevision: "revision-present",
        appleLabel: null,
      }],
    });

    const response = await app.request("/integration/account-factory/v1/mailboxes/sync", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accounts: [{ externalId: "mailbox-present", sourceActive: true }],
      reconciliation: { sourceSystem: "mail_dashboard", deactivated: 1 },
    });
    expect(store.getAccount(missing.id)).toMatchObject({ sourceActive: false });
  });

  it("rejects lifecycle requests whose task lease belongs to another account", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-1" })!;
    const app = createApp(store);

    const response = await app.request("/integration/account-factory/v1/accounts/not-the-account/submission-commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        taskId: claim.lease.taskId,
        leaseId: claim.lease.id,
        operationId: "commit-1",
        idempotencyKey: "commit-key-1",
      }),
    });

    expect(account.id).toBe(claim.account.id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("requires submission commit schema version 1", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-1" })!;
    const app = createApp(store);
    const path = `/integration/account-factory/v1/accounts/${account.id}/submission-commit`;
    const payload = {
      taskId: claim.lease.taskId,
      leaseId: claim.lease.id,
      operationId: "commit-1",
      idempotencyKey: "commit-key-1",
    };
    const request = (body: object) => app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const missingVersion = await request(payload);
    const unsupportedVersion = await request({ ...payload, schemaVersion: 2 });
    const committed = await request({ ...payload, schemaVersion: 1 });

    expect(missingVersion.status).toBe(400);
    expect(await missingVersion.json()).toEqual({ error: "invalid_request" });
    expect(unsupportedVersion.status).toBe(400);
    expect(await unsupportedVersion.json()).toEqual({ error: "invalid_request" });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({
      lease: { state: "committed", submissionCommitted: true },
    });
  });

  it("binds verification polling to the matching task lease and account", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-1" })!;
    let pollCalls = 0;
    const pending = createApp(store, {
      pollVerificationCode: async () => {
        pollCalls += 1;
        return { status: "pending" };
      },
    });
    const unavailable = createApp(store, {
      pollVerificationCode: async () => { throw new MailDashboardError(); },
    });
    const query = `after=2026-08-09T07%3A00%3A00.000Z&taskId=task-1&leaseId=${encodeURIComponent(claim.lease.id)}`;
    const path = `/integration/account-factory/v1/accounts/${account.id}/verification-code?${query}`;

    const pendingResponse = await pending.request(path);
    const unavailableResponse = await unavailable.request(path);
    const missingLease = await pending.request(
      `/integration/account-factory/v1/accounts/${account.id}/verification-code?after=2026-08-09T07%3A00%3A00.000Z`,
    );
    const wrongLease = await pending.request(
      `/integration/account-factory/v1/accounts/${account.id}/verification-code?after=2026-08-09T07%3A00%3A00.000Z&taskId=task-1&leaseId=wrong`,
    );
    const wrongAccount = await pending.request(
      `/integration/account-factory/v1/accounts/not-the-account/verification-code?${query}`,
    );

    expect(await pendingResponse.json()).toEqual({ status: "pending" });
    expect(unavailableResponse.status).toBe(502);
    expect(await unavailableResponse.json()).toEqual({ error: "mail_service_unavailable" });
    expect(missingLease.status).toBe(400);
    expect(await missingLease.json()).toEqual({ error: "invalid_request" });
    expect(wrongLease.status).toBe(404);
    expect(await wrongLease.json()).toEqual({ error: "not_found" });
    expect(wrongAccount.status).toBe(404);
    expect(await wrongAccount.json()).toEqual({ error: "not_found" });
    expect(pollCalls).toBe(1);
  });

  it("passes the millisecond freshness watermark through for a received code", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-received" })!;
    const after = "2026-08-09T07:00:02.001Z";
    let pollInput: { email: string; after: string } | undefined;
    const app = createApp(store, {
      pollVerificationCode: async (email, actualAfter) => {
        pollInput = { email, after: actualAfter };
        return {
          status: "received",
          code: "123456",
          receivedAt: "2026-08-09T07:00:00.000Z",
        };
      },
    });

    const response = await app.request(
      `/integration/account-factory/v1/accounts/${account.id}/verification-code?after=${encodeURIComponent(after)}&taskId=task-received&leaseId=${encodeURIComponent(claim.lease.id)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "received",
      code: "123456",
      receivedAt: "2026-08-09T07:00:00.000Z",
    });
    expect(pollInput).toEqual({ email: "mailbox@example.com", after });
  });

  it("returns lease and sync DTOs without account credentials or mail body data", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-1" })!;
    const app = createApp(store);

    const claimResponse = await app.request("/integration/account-factory/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumerId: "consumer", taskId: "task-1" }),
    });
    const syncResponse = await app.request(
      `/integration/account-factory/v1/accounts/${account.id}/sync-state?taskId=task-1&leaseId=${encodeURIComponent(claim.lease.id)}`,
    );

    const claimBody = await claimResponse.json();
    const syncBody = await syncResponse.json();
    expect(claimResponse.status).toBe(200);
    expect(syncResponse.headers.get("cache-control")).toBe("no-store");
    expect(claimBody.lease).toMatchObject({ hasProgress: false });
    expect(claimBody.lease).not.toHaveProperty("progress");
    expect(syncBody).toMatchObject({
      schemaVersion: 1,
      accountId: account.id,
      lifecycleStatus: "leased",
      revision: 2,
      lastSourceRevision: null,
      hasSession: false,
      hasAccessToken: false,
      hasRefreshToken: false,
    });
    expect(syncBody).not.toHaveProperty("lease");
    expect(JSON.stringify(claimBody)).not.toMatch(/password|accessToken|refreshToken|sessionJson|mailBody/i);
    expect(syncBody).not.toHaveProperty("session");
    expect(syncBody).not.toHaveProperty("accessToken");
    expect(syncBody).not.toHaveProperty("refreshToken");
  });

  it("completes only the owned lease, returns account sync state, and maps stale revisions to a safe 409", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-1" })!;
    const app = createApp(store);
    const ownership = {
      leaseId: claim.lease.id,
      taskId: "task-1",
      idempotencyKey: "complete-key",
    };
    const commit = await app.request(`/integration/account-factory/v1/accounts/${account.id}/submission-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ownership, schemaVersion: 1, operationId: "commit-1" }),
    });
    const completePayload = {
      ...ownership,
      schemaVersion: 1,
      operationId: "complete-1",
      sourceRevision: 4,
      chatgptPassword: "chatgpt-secret",
      session: { user: { email: account.email } },
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      accountStatus: "free",
      registrationRoute: "no-2fa",
      eligibilityStatus: "eligible",
      validityStatus: "valid",
    };
    const completed = await app.request(`/integration/account-factory/v1/accounts/${account.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completePayload),
    });
    const completedBody = await completed.json();
    const replay = await app.request(`/integration/account-factory/v1/accounts/${account.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...completePayload, chatgptPassword: "ignored-secret" }),
    });
    const stale = await app.request(`/integration/account-factory/v1/accounts/${account.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...completePayload, operationId: "complete-stale", sourceRevision: 3 }),
    });

    expect(commit.status).toBe(200);
    expect(completed.status).toBe(200);
    expect(completed.headers.get("cache-control")).toBe("no-store");
    expect(completedBody).toMatchObject({
      schemaVersion: 1,
      accountId: account.id,
      lifecycleStatus: "registered",
      lastSourceRevision: 4,
      lastAppliedOperationId: "complete-1",
      hasSession: true,
      hasAccessToken: true,
      hasRefreshToken: true,
    });
    expect(await replay.json()).toEqual(completedBody);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "revision_conflict", ...completedBody });
    expect(JSON.stringify(completedBody)).not.toContain("secret");
  });

  it("accepts partial completion without a password and allows later evidence updates", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-partial" })!;
    const app = createApp(store);
    const ownership = { leaseId: claim.lease.id, taskId: "task-partial", idempotencyKey: "partial-key" };
    await app.request(`/integration/account-factory/v1/accounts/${account.id}/submission-commit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ownership, schemaVersion: 1, operationId: "partial-commit" }),
    });
    const completed = await app.request(`/integration/account-factory/v1/accounts/${account.id}/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ownership, schemaVersion: 1, operationId: "partial-complete", sourceRevision: 1, session: { user: { email: account.email } }, note: "late note" }),
    });
    expect(completed.status).toBe(200);
    expect(store.getAccount(account.id)).toMatchObject({ chatgptPassword: null, hasSession: true, note: "late note" });
    const evidence = await app.request(`/integration/account-factory/v1/accounts/${account.id}/evidence`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: account.email, eligibilityStatus: "eligible", eligibilityReason: "eligible", eligibilityCheckedAt: "2026-08-14T00:00:00.000Z" }),
    });
    expect(evidence.status).toBe(200);
    expect(store.getAccount(account.id)).toMatchObject({ eligibilityStatus: "eligible", eligibilityReason: "eligible", note: "late note" });
  });

  it("rejects blank passwords and completion requests without account evidence", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-empty-complete" })!;
    const app = createApp(store);
    const ownership = { leaseId: claim.lease.id, taskId: "task-empty-complete", idempotencyKey: "empty-key" };
    await app.request(`/integration/account-factory/v1/accounts/${account.id}/submission-commit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ownership, schemaVersion: 1, operationId: "empty-commit" }),
    });
    const base = { ...ownership, schemaVersion: 1, sourceRevision: 1 };
    const blankPassword = await app.request(`/integration/account-factory/v1/accounts/${account.id}/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, operationId: "blank-password", chatgptPassword: "   " }),
    });
    const empty = await app.request(`/integration/account-factory/v1/accounts/${account.id}/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, operationId: "empty-complete" }),
    });
    expect(blankPassword.status).toBe(400);
    expect(empty.status).toBe(400);
  });

  it("rejects complete when leaseId does not own the task/account", async () => {
    const store = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-1" })!;
    const app = createApp(store);
    const response = await app.request(`/integration/account-factory/v1/accounts/${account.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        leaseId: `${claim.lease.id}-wrong`,
        taskId: "task-1",
        operationId: "complete-1",
        sourceRevision: 1,
        idempotencyKey: "complete-key",
        password: "secret",
      }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("promotes explicitly with allowEphemeral defaulted false and returns a secret-free no-store DTO", async () => {
    const store = createStore();
    const account = sync(store);
    const calls: unknown[] = [];
    const promotion: AccountFactoryPromotion = {
      id: "promotion-1",
      accountId: account.id,
      idempotencyKey: "promote-1",
      mode: "refreshable",
      state: "linked",
      coreAccountId: "core-token-derived-1",
      errorCode: null,
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:01.000Z",
    };
    const app = createApp(store, {}, async (accountId, input) => {
      calls.push({ accountId, input });
      return promotion;
    });

    const response = await app.request(`/integration/account-factory/v1/accounts/${account.id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, idempotencyKey: "promote-1", expectedRevision: 4 }),
    });
    const responseBody = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([{
      accountId: account.id,
      input: { schemaVersion: 1, idempotencyKey: "promote-1", expectedRevision: 4, allowEphemeral: false },
    }]);
    expect(responseBody).toEqual({ promotion });
    expect(JSON.stringify(responseBody)).not.toMatch(/accessToken|refreshToken|session|password|secret/i);
  });

  it("maps AT-only refusal and other promotion errors without invoking implicit complete promotion", async () => {
    const store = createStore();
    const account = sync(store);
    const promote = async () => { throw new AccountFactoryPromotionError("refresh_token_required"); };
    const app = createApp(store, {}, promote);

    const rejected = await app.request(`/integration/account-factory/v1/accounts/${account.id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, idempotencyKey: "promote-at", expectedRevision: 1 }),
    });
    const malformed = await app.request(`/integration/account-factory/v1/accounts/${account.id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, idempotencyKey: "promote-at", expectedRevision: 1, allowEphemeral: "yes" }),
    });

    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "refresh_token_required" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_request" });
  });
});
