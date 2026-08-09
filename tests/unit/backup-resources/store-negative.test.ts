/**
 * Worker 2 — Phase 0 backup-resource negative-case tests.
 *
 * Covers error / edge paths in src/backup-resources/store.ts that the existing
 * tests/unit/backup-resources/store.test.ts does not yet assert:
 * - delete-account on a missing id returns false (does not throw)
 * - get-phone on a missing id returns null
 * - delete-phone on a missing id returns false
 * - update-account / update-phone on missing ids return null
 * - update-account with an empty patch (all fields undefined) is a no-op
 * - update-phone with an empty patch is a no-op
 * - use_phone on a missing id returns null
 * - close() then any operation throws "database is not open"
 * - update_phone with negative use_count violates CHECK constraint
 * - constructor rollback when verifyEncryptionKey throws (DB is closed)
 *
 * No source edits; additive test files only.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";
import { BACKUP_ENCRYPTION_KEY_CHECK } from "@fixtures/backup-resources/migration-constants.js";

const tempDirs: string[] = [];
const stores: BackupResourceStore[] = [];

function trackTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "backup-negative-"));
  tempDirs.push(dir);
  return dir;
}

function openStore(dir: string, cipher = createTestCipher()): {
  store: BackupResourceStore;
  path: string;
} {
  const path = join(dir, "backup-resources.sqlite");
  const store = new BackupResourceStore(path, cipher);
  stores.push(store);
  return { store, path };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("BackupResourceStore negative — read paths return null on miss", () => {
  it("getAccount returns null for an unknown id", () => {
    const { store } = openStore(trackTempDir());
    expect(store.getAccount("does-not-exist")).toBeNull();
  });

  it("getPhone returns null for an unknown id", () => {
    const { store } = openStore(trackTempDir());
    expect(store.getPhone("does-not-exist")).toBeNull();
  });

  it("deleteAccount returns false when the id is unknown", () => {
    const { store } = openStore(trackTempDir());
    expect(store.deleteAccount("does-not-exist")).toBe(false);
  });

  it("deletePhone returns false when the id is unknown", () => {
    const { store } = openStore(trackTempDir());
    expect(store.deletePhone("does-not-exist")).toBe(false);
  });

  it("updateAccount returns null for an unknown id", () => {
    const { store } = openStore(trackTempDir());
    expect(store.updateAccount("does-not-exist", { note: "x" })).toBeNull();
  });

  it("updatePhone returns null for an unknown id", () => {
    const { store } = openStore(trackTempDir());
    expect(store.updatePhone("does-not-exist", { note: "x" })).toBeNull();
  });

  it("usePhone returns null for an unknown id", () => {
    const { store } = openStore(trackTempDir());
    expect(store.usePhone("does-not-exist")).toBeNull();
  });
});

describe("BackupResourceStore negative — empty patches are no-ops", () => {
  it("updateAccount with no fields set returns the existing summary unchanged", () => {
    const { store } = openStore(trackTempDir());
    const created = store.createAccount({
      email: "user@example.com",
      note: "before",
    });

    const updated = store.updateAccount(created.id, {});

    expect(updated).toEqual(created);
    expect(store.getAccount(created.id)).toMatchObject({
      email: "user@example.com",
      note: "before",
    });
  });

  it("updatePhone with no fields set returns the existing phone unchanged", () => {
    const { store } = openStore(trackTempDir());
    const created = store.createPhone({ phoneNumber: "+15555550100", note: "stable" });

    const updated = store.updatePhone(created.id, {});

    expect(updated).toEqual(created);
    expect(store.getPhone(created.id)).toMatchObject({
      phoneNumber: "+15555550100",
      note: "stable",
      useCount: 0,
    });
  });
});

describe("BackupResourceStore negative — CHECK and lifecycle invariants", () => {
  it("rejects updatePhone with a negative use_count (CHECK constraint)", () => {
    const { store } = openStore(trackTempDir());
    const phone = store.createPhone({ phoneNumber: "+15555550111" });

    expect(() => store.updatePhone(phone.id, { useCount: -1 })).toThrow(/CHECK constraint/);
  });

  it("close() then listAccounts throws because the underlying db is closed", () => {
    const dir = trackTempDir();
    const { store } = openStore(dir);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    expect(() => store.listAccounts()).toThrow();
  });

  it("constructor rolls back the underlying db when verifyEncryptionKey throws", () => {
    const dir = trackTempDir();
    const { store, path } = openStore(dir);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const raw = new Database(path);
    raw.prepare("UPDATE backup_metadata SET value = ? WHERE key = ?")
      .run("v1:AAAA:AAAA:AAAA", BACKUP_ENCRYPTION_KEY_CHECK);
    raw.close();

    let ctorError: unknown;
    let constructed: BackupResourceStore | undefined;
    try {
      constructed = new BackupResourceStore(path, createTestCipher());
    } catch (error) {
      ctorError = error;
    }

    expect(ctorError).toBeInstanceOf(Error);
    expect(constructed).toBeUndefined();

    const probe = new Database(path, { readonly: true });
    const accounts = probe
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_accounts'")
      .all();
    expect(accounts).toHaveLength(1);
    probe.close();
  });
});
