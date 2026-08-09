/**
 * Worker 2 — Phase 0 backup-resource migration coverage tests.
 *
 * Targets the migration-like operations in src/backup-resources/store.ts:
 * - ensureAccountStatusColumn (idempotent ALTER for legacy schema)
 * - verifyEncryptionKey (key-check row bootstrap and re-authentication)
 * - CREATE TABLE IF NOT EXISTS bootstrap
 *
 * No source edits; additive test files only.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { createTestCipher, createWrongCipher } from "@fixtures/backup-resources/cipher-fixtures.js";
import {
  createLegacyV0Database,
  closeLegacyV0Database,
} from "@fixtures/backup-resources/legacy-v0-schema.js";
import {
  BACKUP_ENCRYPTION_KEY_CHECK,
  BACKUP_KEY_CHECK_V1_MARKER,
} from "@fixtures/backup-resources/migration-constants.js";

const tempDirs: string[] = [];
const stores: BackupResourceStore[] = [];

function trackTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "backup-migration-"));
  tempDirs.push(dir);
  return dir;
}

function openStore(
  dir: string,
  cipher = createTestCipher(),
): {
  store: BackupResourceStore;
  path: string;
  cipher: ReturnType<typeof createTestCipher>;
} {
  const path = join(dir, "backup-resources.sqlite");
  const store = new BackupResourceStore(path, cipher);
  stores.push(store);
  return { store, path, cipher };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("BackupResourceStore migration — ensureAccountStatusColumn", () => {
  it("adds account_status to a legacy v0 schema and defaults existing rows to unregistered", () => {
    const dir = trackTempDir();
    const path = join(dir, "backup-resources.sqlite");
    const cipher = createTestCipher();
    const handle = createLegacyV0Database(path, cipher, {
      insertAccount: { id: "legacy-1", email: "legacy@example.com" },
    });
    closeLegacyV0Database(handle);

    const { store } = openStore(dir, cipher);

    expect(store.getAccount("legacy-1")).toMatchObject({
      email: "legacy@example.com",
      accountStatus: "unregistered",
    });

    const raw = new Database(path, { readonly: true });
    const columns = raw
      .prepare("SELECT name FROM pragma_table_info('backup_accounts')")
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "account_status")).toBe(true);
    raw.close();
  });

  it("does not duplicate account_status on a v0 schema that already has the column", () => {
    const dir = trackTempDir();
    const path = join(dir, "backup-resources.sqlite");
    const cipher = createTestCipher();
    const handle = createLegacyV0Database(path, cipher);
    handle.db.exec(`
      ALTER TABLE backup_accounts
      ADD COLUMN account_status TEXT NOT NULL DEFAULT 'plus'
        CHECK (account_status IN ('plus', 'free', 'unregistered', 'pro'))
    `);
    closeLegacyV0Database(handle);

    const { store } = openStore(dir, cipher);

    const raw = new Database(path, { readonly: true });
    const rows = raw
      .prepare("SELECT name FROM pragma_table_info('backup_accounts') WHERE name = 'account_status'")
      .all() as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    raw.close();

    expect(store.createAccount({ email: "new@example.com" })).toMatchObject({
      accountStatus: "unregistered",
    });
  });
});

describe("BackupResourceStore migration — verifyEncryptionKey", () => {
  it("writes the key-check row on a fresh database and refuses to re-write on reopen", () => {
    const dir = trackTempDir();
    const { store, path, cipher } = openStore(dir);

    const raw = new Database(path, { readonly: true });
    const initial = raw
      .prepare("SELECT value FROM backup_metadata WHERE key = ?")
      .get(BACKUP_ENCRYPTION_KEY_CHECK) as { value: string };
    expect(initial.value.startsWith("v1:")).toBe(true);
    raw.close();

    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new BackupResourceStore(path, cipher);
    stores.push(reopened);

    const raw2 = new Database(path, { readonly: true });
    const rows = raw2
      .prepare("SELECT value FROM backup_metadata WHERE key = ?")
      .all(BACKUP_ENCRYPTION_KEY_CHECK) as Array<{ value: string }>;
    expect(rows).toHaveLength(1);
    raw2.close();
  });

  it("rejects a freshly-opened database whose key-check ciphertext was tampered", () => {
    const dir = trackTempDir();
    const { store, path, cipher } = openStore(dir);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const raw = new Database(path);
    raw.prepare("UPDATE backup_metadata SET value = ? WHERE key = ?")
      .run("v1:AAAA:AAAA:AAAA", BACKUP_ENCRYPTION_KEY_CHECK);
    raw.close();

    expect(() => new BackupResourceStore(path, cipher)).toThrow();
  });

  it("refuses to open a populated database whose key-check row was deleted", () => {
    const dir = trackTempDir();
    const path = join(dir, "backup-resources.sqlite");
    const cipher = createTestCipher();
    const handle = createLegacyV0Database(path, cipher, {
      includeKeyCheck: false,
      insertAccount: { id: "legacy-1", email: "legacy@example.com" },
    });
    closeLegacyV0Database(handle);

    expect(() => new BackupResourceStore(path, cipher)).toThrow(
      /encryption key verification metadata is missing/i,
    );
  });

  it("allows a fresh (empty) database with no key-check row by inserting one", () => {
    const dir = trackTempDir();
    const path = join(dir, "backup-resources.sqlite");
    const cipher = createTestCipher();
    const handle = createLegacyV0Database(path, cipher, { includeKeyCheck: false });
    closeLegacyV0Database(handle);

    const store = new BackupResourceStore(path, cipher);
    stores.push(store);

    const raw = new Database(path, { readonly: true });
    const value = (raw
      .prepare("SELECT value FROM backup_metadata WHERE key = ?")
      .get(BACKUP_ENCRYPTION_KEY_CHECK) as { value: string }).value;
    expect(value.startsWith("v1:")).toBe(true);
    expect(store.getAccount("legacy-1")).toBeNull();
    raw.close();
  });

  it("refuses to open when the cipher key does not match the key-check sentinel", () => {
    const dir = trackTempDir();
    const { store, path } = openStore(dir);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    expect(() => new BackupResourceStore(path, createWrongCipher())).toThrow();
  });

  it("round-trips the v1 marker through the cipher (encrypt/decrypt parity)", () => {
    const cipher = createTestCipher();
    const roundTripped = cipher.decrypt(cipher.encrypt(BACKUP_KEY_CHECK_V1_MARKER));
    expect(roundTripped).toBe(BACKUP_KEY_CHECK_V1_MARKER);
  });
});
