import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";

const stores: BackupResourceStore[] = [];
const tempDirs: string[] = [];

function createStore(): { store: BackupResourceStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "account-factory-lifecycle-"));
  tempDirs.push(dir);
  const path = join(dir, "backup-resources.sqlite");
  const store = new BackupResourceStore(path, createTestCipher());
  stores.push(store);
  return { store, path };
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

  it("reclaims an expired uncommitted lease but never reclaims a committed submission", () => {
    const { store, path } = createStore();
    const account = sync(store);
    const first = store.claimAccount({ consumerId: "consumer-1", taskId: "task-1", leaseTtlMs: 60_000 })!;
    const db = new Database(path);
    db.prepare("UPDATE account_factory_leases SET claim_expires_at = ? WHERE task_id = ?")
      .run("2000-01-01T00:00:00.000Z", "task-1");
    db.close();

    expect(store.commitSubmission({ taskId: "task-1" })).toMatchObject({ state: "retired" });
    expect(store.getLease("task-1")).toMatchObject({ state: "retired" });

    const reclaimed = store.claimAccount({ consumerId: "consumer-2", taskId: "task-2" });
    expect(reclaimed).toMatchObject({ account: { id: account.id }, replayed: false });

    store.commitSubmission({ taskId: "task-2", operationId: "commit-1" });
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
    store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" });

    const progress = store.reportProgress({
      taskId: "task-1",
      operationId: "progress-1",
      progress: { stage: "邮箱验证码", current: 2, total: 3 },
    });
    const changed = store.reportProgress({
      taskId: "task-1",
      operationId: "progress-2",
      progress: { stage: "submitted", current: 3, total: 3 },
    });
    const replay = store.reportProgress({
      taskId: "task-1",
      operationId: "progress-1",
      progress: { stage: "ignored" },
    });

    expect(changed.progress).toEqual({ stage: "submitted", current: 3, total: 3 });
    expect(replay).toEqual(progress);
    expect(() => store.reportProgress({ taskId: "task-other", operationId: "progress-1", progress: {} }))
      .toThrow(/reused for a different operation/);
    expect(() => store.commitSubmission({ taskId: "task-1", operationId: "progress-1" }))
      .toThrow(/reused for a different operation/);
  });

  it("requires submission commit before completion and preserves terminal results on replay", () => {
    const { store } = createStore();
    sync(store);
    store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" });

    expect(() => store.completeLease({ taskId: "task-1" })).toThrow(/committed first/);
    store.commitSubmission({ taskId: "task-1" });
    const completed = store.completeLease({ taskId: "task-1", operationId: "complete-1", accountStatus: "plus" });
    const replay = store.completeLease({ taskId: "task-1", operationId: "complete-1", accountStatus: "free" });

    expect(completed).toMatchObject({ state: "completed" });
    expect(replay).toEqual(completed);
    expect(() => store.completeLease({ taskId: "task-1", operationId: "complete-2" }))
      .toThrow(/terminal/);
    expect(store.getSyncState("mail_dashboard")).toMatchObject({ registeredAccounts: 1 });
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
    store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" });

    const failed = store.failLease({ taskId: "task-1", errorCode: "mail_timeout" });
    const reclaimed = store.claimAccount({ consumerId: "consumer-2", taskId: "task-2" });
    store.commitSubmission({ taskId: "task-2" });
    const committedFailure = store.failLease({ taskId: "task-2", errorCode: "submission_rejected" });

    expect(failed).toMatchObject({ state: "failed", failureCode: "mail_timeout" });
    expect(reclaimed).toMatchObject({ account: { id: account.id } });
    expect(committedFailure).toMatchObject({ state: "failed", failureCode: "submission_rejected" });
    expect(store.getSyncState("mail_dashboard")).toMatchObject({ availableAccounts: 0 });
  });

  it("does not replay a terminal task claim after its account is reassigned", () => {
    const { store } = createStore();
    const account = sync(store);
    store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" });
    store.failLease({ taskId: "task-1", errorCode: "mail_timeout" });

    const reassigned = store.claimAccount({ consumerId: "consumer-2", taskId: "task-2" });
    const retry = store.claimAccount({ consumerId: "consumer-1", taskId: "task-1" });

    expect(reassigned).toMatchObject({ account: { id: account.id } });
    expect(retry).toBeNull();
  });
});
