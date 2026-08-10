import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";

const stores: BackupResourceStore[] = [];
const tempDirs: string[] = [];

function createStore(): { store: BackupResourceStore; path: string; cipher: ReturnType<typeof createTestCipher> } {
  const dir = mkdtempSync(join(tmpdir(), "account-factory-lifecycle-"));
  tempDirs.push(dir);
  const path = join(dir, "backup-resources.sqlite");
  const cipher = createTestCipher();
  const store = new BackupResourceStore(path, cipher);
  stores.push(store);
  return { store, path, cipher };
}

function sync(store: BackupResourceStore, externalId = "mail-1", sourceRevision = "rev-1") {
  return store.syncSourceAccount({
    sourceSystem: "mail_dashboard",
    externalId,
    email: `${externalId}@example.com`,
    sourceRevision,
    appleLabel: externalId,
  });
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("BackupResourceStore account-factory lifecycle", () => {
  it("syncs source accounts idempotently and ignores an already-applied source revision", () => {
    const { store } = createStore();

    const first = sync(store);
    const replay = sync(store);
    const updated = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mail-1",
      email: "renamed@example.com",
      sourceRevision: "rev-2",
      active: false,
      appleLabel: "renamed",
    });

    expect(replay).toEqual(first);
    expect(updated).toMatchObject({
      id: first.id,
      email: "renamed@example.com",
      sourceActive: false,
      appleLabel: "renamed",
      revision: 2,
      sourceRevision: "rev-2",
    });
    expect(store.getSyncState("mail_dashboard")).toMatchObject({
      activeAccounts: 0,
      availableAccounts: 0,
    });
  });

  it("adopts an existing manual account when the mail source syncs the same email", () => {
    const { store } = createStore();
    const manual = store.createAccount({
      email: "existing@example.com",
      accountStatus: "free",
      chatgptPassword: "preserved-password",
    });

    const synced = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "existing@example.com",
      email: "EXISTING@example.com",
      sourceRevision: "existing@example.com:apple-label",
      appleLabel: "apple-label",
    });

    expect(synced).toMatchObject({
      id: manual.id,
      sourceSystem: "mail_dashboard",
      externalId: "existing@example.com",
      appleLabel: "apple-label",
      lifecycleStatus: "registered",
    });
    expect(store.getAccount(manual.id)).toMatchObject({
      chatgptPassword: "preserved-password",
      accountStatus: "free",
    });
    expect(store.listAccounts()).toHaveLength(1);
  });

  it("retires used mailbox records and restores only evidence-free unregistered mailboxes", () => {
    const { store } = createStore();
    const used = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "used@example.com",
      email: "used@example.com",
      sourceRevision: "used:finished",
      registrationEligible: false,
    });

    expect(used.lifecycleStatus).toBe("retired");
    expect(store.claimAccount({ consumerId: "consumer", taskId: "task-used" })).toBeNull();

    const restored = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "used@example.com",
      email: "used@example.com",
      sourceRevision: "used:unused",
      registrationEligible: true,
    });
    expect(restored.lifecycleStatus).toBe("available");

    const knownGpt = store.createAccount({
      email: "known@example.com",
      accountStatus: "free",
      chatgptPassword: "already-registered",
    });
    expect(knownGpt.lifecycleStatus).toBe("available");
    expect(store.claimAccount({ consumerId: "consumer", taskId: "task-known" })).toMatchObject({
      account: { id: restored.id },
    });
    expect(store.claimAccount({ consumerId: "consumer", taskId: "task-known-2" })).toBeNull();
  });

  it("deactivates only missing source records without changing leases or lifecycle state", () => {
    const { store } = createStore();
    const missing = sync(store, "mail-missing");
    const lease = store.claimAccount({ consumerId: "consumer", taskId: "task-missing" })!.lease;
    const retained = sync(store, "mail-retained");
    const extension = store.syncSourceAccount({
      sourceSystem: "extension",
      externalId: "extension-1",
      email: "extension@example.com",
      sourceRevision: "extension-rev-1",
    });

    const first = store.reconcileSourceAccounts({
      sourceSystem: "mail_dashboard",
      activeExternalIds: ["mail-retained", "mail-retained"],
    });
    const replay = store.reconcileSourceAccounts({
      sourceSystem: "mail_dashboard",
      activeExternalIds: ["mail-retained"],
    });

    expect(first).toEqual({ sourceSystem: "mail_dashboard", deactivated: 1 });
    expect(replay).toEqual({ sourceSystem: "mail_dashboard", deactivated: 0 });
    expect(store.getAccount(missing.id)).toMatchObject({
      sourceActive: false,
      lifecycleStatus: "leased",
    });
    expect(store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mail-missing",
      email: "mail-missing@example.com",
      sourceRevision: "rev-1",
      appleLabel: "mail-missing",
    })).toMatchObject({ sourceActive: true, lifecycleStatus: "leased" });
    expect(store.getLease("task-missing")).toEqual(lease);
    expect(store.getAccount(retained.id)).toMatchObject({ sourceActive: true });
    expect(store.getAccount(extension.id)).toMatchObject({ sourceActive: true, sourceSystem: "extension" });
  });

  it("gives one account to one task while replaying an existing task claim", async () => {
    const { store } = createStore();
    const account = sync(store);

    const claims = await Promise.all(Array.from({ length: 10 }, (_, index) => Promise.resolve(
      store.claimAccount({ consumerId: `consumer-${index}`, taskId: `task-${index}` }),
    )));
    const claimed = claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null);
    const replay = store.claimAccount({ consumerId: "another-consumer", taskId: claimed[0].lease.taskId });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].account.id).toBe(account.id);
    expect(replay).toMatchObject({
      replayed: true,
      account: { id: account.id },
      lease: { id: claimed[0].lease.id, consumerId: claimed[0].lease.consumerId },
    });
  });

  it("lists only strict candidates and limits claims to the selected account set", () => {
    const { store } = createStore();
    const first = sync(store, "mail-first");
    const second = sync(store, "mail-second");
    store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mail-blocked",
      email: "mail-blocked@example.com",
      sourceRevision: "blocked",
      registrationEligible: false,
    });
    store.createAccount({
      email: "registered@example.com",
      accountStatus: "free",
      chatgptPassword: "already-used",
    });
    store.createAccount({ email: "manual-unregistered@example.com" });

    expect(store.listClaimableAccounts(10).map((account) => account.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.claimAccount({
      consumerId: "consumer",
      taskId: "selected-task",
      selectedAccountIds: [second.id],
    })).toMatchObject({ account: { id: second.id } });
    expect(store.claimAccount({
      consumerId: "consumer",
      taskId: "missing-selected-task",
      selectedAccountIds: ["not-available"],
    })).toBeNull();
  });

  it("reclaims an expired uncommitted lease but never reclaims a committed submission", () => {
    const { store, path } = createStore();
    const account = sync(store);
    const first = store.claimAccount({ consumerId: "consumer-1", taskId: "task-1", leaseTtlMs: 60_000 })!;
    const db = new Database(path);
    db.prepare("UPDATE account_factory_leases SET claim_expires_at = ? WHERE task_id = ?")
      .run("2000-01-01T00:00:00.000Z", "task-1");
    db.close();

    expect(store.commitSubmission({ taskId: "task-1", leaseId: first.lease.id, idempotencyKey: "commit-expired" })).toMatchObject({ state: "retired" });
    expect(store.getLease("task-1")).toMatchObject({ state: "retired" });

    const reclaimed = store.claimAccount({ consumerId: "consumer-2", taskId: "task-2" });
    expect(reclaimed).toMatchObject({ account: { id: account.id }, replayed: false });

    store.commitSubmission({ taskId: "task-2", leaseId: reclaimed!.lease.id, operationId: "commit-1", idempotencyKey: "commit-1" });
    const unavailable = store.claimAccount({ consumerId: "consumer-3", taskId: "task-3" });

    expect(unavailable).toBeNull();
    expect(store.getLease("task-2")).toMatchObject({
      state: "committed",
      submissionCommitted: true,
      claimExpiresAt: null,
    });
    expect(first.lease.accountId).toBe(account.id);
  });

  it("persists progress and replays mutation results by operation id", () => {
    const { store } = createStore();
    sync(store);
    const claim = store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" })!;

    const progress = store.reportProgress({
      taskId: "task-1",
      leaseId: claim.lease.id,
      idempotencyKey: "progress-1",
      operationId: "progress-1",
      progress: { stage: "邮箱验证码", current: 2, total: 3 },
    });
    const changed = store.reportProgress({
      taskId: "task-1",
      leaseId: claim.lease.id,
      idempotencyKey: "progress-2",
      operationId: "progress-2",
      progress: { stage: "submitted", current: 3, total: 3 },
    });
    const replay = store.reportProgress({
      taskId: "task-1",
      leaseId: claim.lease.id,
      idempotencyKey: "progress-1",
      operationId: "progress-1",
      progress: { stage: "ignored" },
    });

    expect(changed.progress).toEqual({ stage: "submitted", current: 3, total: 3 });
    expect(replay).toEqual(progress);
    expect(() => store.reportProgress({ taskId: "task-other", leaseId: claim.lease.id, idempotencyKey: "progress-1", operationId: "progress-1", progress: {} }))
      .toThrow(/reused for a different operation/);
    expect(() => store.commitSubmission({ taskId: "task-1", leaseId: claim.lease.id, idempotencyKey: "progress-1", operationId: "progress-1" }))
      .toThrow(/reused for a different operation/);
  });

  it("encrypts completion credentials and keeps client and mailbox revisions independent", () => {
    const { store, path, cipher } = createStore();
    const account = sync(store, "mail-1", "mail-rev-1");
    const claim = store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" })!;
    const ownership = { taskId: "task-1", leaseId: claim.lease.id, idempotencyKey: "complete-key" };

    expect(() => store.completeLease({
      ...ownership, schemaVersion: 1, operationId: "complete-before-commit", sourceRevision: 1, password: "secret-password",
    })).toThrow(/committed first/);
    store.commitSubmission({ ...ownership, operationId: "commit-1" });
    const completed = store.completeLease({
      ...ownership,
      schemaVersion: 1,
      operationId: "complete-1",
      sourceRevision: 7,
      password: "secret-password",
      emailPassword: "mail-password",
      totpSecret: "totp-secret",
      session: { user: { email: account.email } },
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accountStatus: "plus",
      registrationRoute: "totp",
      eligibilityStatus: "eligible",
      validityStatus: "valid",
    });
    const replay = store.completeLease({
      ...ownership, schemaVersion: 1, operationId: "complete-1", sourceRevision: 7, password: "ignored-password",
    });

    expect(completed).toMatchObject({
      schemaVersion: 1,
      accountId: account.id,
      lifecycleStatus: "registered",
      lastSourceRevision: 7,
      lastAppliedOperationId: "complete-1",
      hasSession: true,
      hasAccessToken: true,
      hasRefreshToken: true,
    });
    expect(replay).toEqual(completed);
    const db = new Database(path);
    const persisted = db.prepare(`
      SELECT chatgpt_password, email_password, totp_secret, session_json, access_token,
             refresh_token, last_source_revision, last_client_revision
      FROM backup_accounts WHERE id = ?
    `).get(account.id) as Record<string, string | number | null>;
    db.close();
    expect(persisted.last_source_revision).toBe("mail-rev-1");
    expect(persisted.last_client_revision).toBe(7);
    expect(persisted.chatgpt_password).not.toBe("secret-password");
    expect(cipher.decrypt(String(persisted.chatgpt_password))).toBe("secret-password");

    store.syncSourceAccount({
      sourceSystem: "mail_dashboard", externalId: "mail-1", email: account.email,
      sourceRevision: "mail-rev-2", appleLabel: "updated",
    });
    expect(store.getAccountSyncState(account.id)).toMatchObject({
      lastSourceRevision: 7,
      lastAppliedOperationId: "complete-1",
    });
    const dbAfterSync = new Database(path, { readonly: true });
    expect(dbAfterSync.prepare("SELECT last_source_revision FROM backup_accounts WHERE id = ?").get(account.id))
      .toEqual({ last_source_revision: "mail-rev-2" });
    dbAfterSync.close();
  });

  it("replays the same complete without a revision bump, accepts newer client state, and safely rejects stale state", () => {
    const { store } = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-1" })!;
    const base = { schemaVersion: 1 as const, taskId: "task-1", leaseId: claim.lease.id, idempotencyKey: "complete-key" };
    store.commitSubmission({ taskId: "task-1", leaseId: claim.lease.id, idempotencyKey: "commit-key", operationId: "commit-1" });
    const first = store.completeLease({ ...base, operationId: "complete-1", sourceRevision: 5, password: "password-1" });
    const replay = store.completeLease({ ...base, operationId: "complete-1", sourceRevision: 5, password: "ignored" });
    const newer = store.completeLease({ ...base, operationId: "complete-2", sourceRevision: 6, password: "password-2" });

    expect(replay).toEqual(first);
    expect(newer.revision).toBe(first.revision + 1);
    expect(newer.lastSourceRevision).toBe(6);
    expect(() => store.completeLease({ ...base, operationId: "complete-stale", sourceRevision: 4, password: "stale" }))
      .toThrow(/source revision conflict/);
    expect(store.getAccountSyncState(account.id)).toEqual(newer);
  });

  it("never implicitly promotes on complete and never demotes an explicitly linked account", () => {
    const { store } = createStore();
    const account = sync(store);
    const claim = store.claimAccount({ consumerId: "consumer", taskId: "task-promote" })!;
    const ownership = {
      schemaVersion: 1 as const,
      taskId: "task-promote",
      leaseId: claim.lease.id,
      idempotencyKey: "complete-promote",
    };
    store.commitSubmission({ ...ownership, operationId: "commit-promote" });
    const completed = store.completeLease({
      ...ownership,
      operationId: "complete-before-promote",
      sourceRevision: 1,
      password: "password",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    expect(completed.lifecycleStatus).toBe("registered");
    expect(store.getPromotion(account.id)).toBeNull();

    store.planPromotion(account.id, {
      schemaVersion: 1,
      idempotencyKey: "explicit-promotion",
      expectedRevision: completed.revision,
      allowEphemeral: false,
    });
    store.markPromotionImporting(account.id, "explicit-promotion");
    store.markPromotionImported(account.id, "explicit-promotion", "core-account");
    store.linkPromotion(account.id, "explicit-promotion");

    const laterComplete = store.completeLease({
      ...ownership,
      operationId: "complete-after-promote",
      sourceRevision: 2,
      password: "updated-password",
    });
    expect(laterComplete.lifecycleStatus).toBe("promoted");
    expect(store.getPromotion(account.id)).toMatchObject({
      state: "linked",
      coreAccountId: "core-account",
    });
  });

  it("rejects an operation id reused to sync a different source identity", () => {
    const { store } = createStore();
    store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mail-1",
      email: "mail-1@example.com",
      sourceRevision: "rev-1",
      operationId: "sync-1",
    });

    expect(() => store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mail-2",
      email: "mail-2@example.com",
      sourceRevision: "rev-1",
      operationId: "sync-1",
    })).toThrow(/reused for a different operation/);
  });

  it("returns uncommitted failures to the pool and records committed failures as invalid", () => {
    const { store } = createStore();
    const account = sync(store);
    const first = store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" })!;

    const failed = store.failLease({ taskId: "task-1", leaseId: first.lease.id, idempotencyKey: "fail-1", errorCode: "mail_timeout" });
    const reclaimed = store.claimAccount({ consumerId: "consumer-2", taskId: "task-2" })!;
    store.commitSubmission({ taskId: "task-2", leaseId: reclaimed.lease.id, idempotencyKey: "commit-2" });
    const committedFailure = store.failLease({ taskId: "task-2", leaseId: reclaimed.lease.id, idempotencyKey: "fail-2", errorCode: "submission_rejected" });

    expect(failed).toMatchObject({ state: "failed", failureCode: "mail_timeout" });
    expect(reclaimed).toMatchObject({ account: { id: account.id } });
    expect(committedFailure).toMatchObject({ state: "failed", failureCode: "submission_rejected" });
    expect(store.getSyncState("mail_dashboard")).toMatchObject({ availableAccounts: 0 });
  });

  it("does not replay a terminal task claim after its account is reassigned", () => {
    const { store } = createStore();
    const account = sync(store);
    const first = store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" })!;
    store.failLease({ taskId: "task-1", leaseId: first.lease.id, idempotencyKey: "fail-1", errorCode: "mail_timeout" });

    const reassigned = store.claimAccount({ consumerId: "consumer-2", taskId: "task-2" });
    const retry = store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" });

    expect(reassigned).toMatchObject({ account: { id: account.id } });
    expect(retry).toBeNull();
  });
});
