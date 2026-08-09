import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";

const tempDirs: string[] = [];
const stores: BackupResourceStore[] = [];

function openStore(): { store: BackupResourceStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "account-factory-schema-"));
  tempDirs.push(dir);
  const path = join(dir, "backup-resources.sqlite");
  const store = new BackupResourceStore(path, createTestCipher());
  stores.push(store);
  return { store, path };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("account-factory schema contract", () => {
  it("enforces one active lease per account while preserving committed ownership", () => {
    const { store, path } = openStore();
    const account = store.createAccount({ email: "factory@example.com" });
    const db = new Database(path);

    db.prepare(`
      INSERT INTO account_factory_leases (
        id, account_id, consumer_id, task_id, state, claim_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "lease-1",
      account.id,
      "consumer-1",
      "task-1",
      "leased",
      "2026-08-09T08:00:00.000Z",
      "2026-08-09T07:00:00.000Z",
      "2026-08-09T07:00:00.000Z",
    );

    expect(() => db.prepare(`
      INSERT INTO account_factory_leases (
        id, account_id, consumer_id, task_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "lease-2",
      account.id,
      "consumer-2",
      "task-2",
      "leased",
      "2026-08-09T07:00:00.000Z",
      "2026-08-09T07:00:00.000Z",
    )).toThrow(/UNIQUE constraint failed/);

    db.prepare(`
      UPDATE account_factory_leases
      SET state = 'committed', email_submission_committed = 1,
          email_submission_committed_at = '2026-08-09T07:01:00.000Z'
      WHERE id = ?
    `).run("lease-1");

    expect(() => db.prepare(`
      INSERT INTO account_factory_leases (
        id, account_id, consumer_id, task_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "lease-3",
      account.id,
      "consumer-3",
      "task-3",
      "leased",
      "2026-08-09T07:02:00.000Z",
      "2026-08-09T07:02:00.000Z",
    )).toThrow(/UNIQUE constraint failed/);

    db.prepare("UPDATE account_factory_leases SET state = 'completed' WHERE id = ?").run("lease-1");
    expect(() => db.prepare(`
      INSERT INTO account_factory_leases (
        id, account_id, consumer_id, task_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "lease-4",
      account.id,
      "consumer-4",
      "task-4",
      "leased",
      "2026-08-09T07:03:00.000Z",
      "2026-08-09T07:03:00.000Z",
    )).not.toThrow();

    db.close();
  });

  it("enforces task, promotion, source identity, and lifecycle constraints", () => {
    const { store, path } = openStore();
    const first = store.createAccount({ email: "first@example.com" });
    const second = store.createAccount({ email: "second@example.com" });
    const db = new Database(path);

    try {
      db.prepare(`
        INSERT INTO account_factory_leases (
          id, account_id, consumer_id, task_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("lease-1", first.id, "consumer-1", "repeat-task", "leased", "2026-08-09T07:00:00.000Z", "2026-08-09T07:00:00.000Z");

      expect(() => db.prepare(`
        INSERT INTO account_factory_leases (
          id, account_id, consumer_id, task_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("lease-2", second.id, "consumer-2", "repeat-task", "leased", "2026-08-09T07:01:00.000Z", "2026-08-09T07:01:00.000Z")).toThrow(/UNIQUE constraint failed/);

      db.prepare(`
        INSERT INTO account_factory_promotions (
          id, account_id, idempotency_key, mode, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("promotion-1", first.id, "operation-1", "refreshable", "planned", "2026-08-09T07:00:00.000Z", "2026-08-09T07:00:00.000Z");

      expect(() => db.prepare(`
        INSERT INTO account_factory_promotions (
          id, account_id, idempotency_key, mode, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("promotion-2", second.id, "operation-1", "ephemeral", "planned", "2026-08-09T07:01:00.000Z", "2026-08-09T07:01:00.000Z")).toThrow(/UNIQUE constraint failed/);
      expect(() => db.prepare(`
        INSERT INTO account_factory_promotions (
          id, account_id, idempotency_key, mode, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("promotion-3", first.id, "operation-2", "ephemeral", "planned", "2026-08-09T07:01:00.000Z", "2026-08-09T07:01:00.000Z")).toThrow(/UNIQUE constraint failed/);

      db.prepare(`
        UPDATE backup_accounts
        SET source_system = 'mail_dashboard', external_id = 'mailbox-1'
        WHERE id = ?
      `).run(first.id);
      expect(() => db.prepare(`
        UPDATE backup_accounts
        SET source_system = 'mail_dashboard', external_id = 'mailbox-1'
        WHERE id = ?
      `).run(second.id)).toThrow(/UNIQUE constraint failed/);
      expect(() => db.prepare("UPDATE backup_accounts SET lifecycle_status = 'unknown' WHERE id = ?").run(second.id)).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});
