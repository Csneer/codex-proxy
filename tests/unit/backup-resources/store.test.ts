import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BackupSecretCipher } from "@src/backup-resources/crypto.js";
import { BackupResourceStore } from "@src/backup-resources/store.js";

const stores: BackupResourceStore[] = [];

function createStore(): { store: BackupResourceStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "backup-store-")), "backup-resources.sqlite");
  const store = new BackupResourceStore(path, new BackupSecretCipher(randomBytes(32)));
  stores.push(store);
  return { store, path };
}

function createLegacyStore(): { store: BackupResourceStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "backup-store-legacy-")), "backup-resources.sqlite");
  const key = randomBytes(32);
  const cipher = new BackupSecretCipher(key);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE backup_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE backup_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      email_password TEXT,
      chatgpt_password TEXT,
      totp_secret TEXT,
      email_code_url TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE backup_phones (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO backup_metadata (key, value) VALUES (?, ?)")
    .run("encryption_key_check", cipher.encrypt("codex-proxy-backup-resources-v1"));
  db.prepare(`
    INSERT INTO backup_accounts (id, email, created_at, updated_at)
    VALUES ('legacy-account', 'legacy@example.com', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run();
  db.close();
  const store = new BackupResourceStore(path, new BackupSecretCipher(key));
  stores.push(store);
  return { store, path };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("BackupResourceStore", () => {
  it("encrypts only secrets and keeps account list responses secret-free", () => {
    const { store, path } = createStore();
    const created = store.createAccount({
      email: "user@example.com",
      accountStatus: "plus",
      emailPassword: "email-password",
      chatgptPassword: "chatgpt-password",
      totpSecret: "totp-secret",
      emailCodeUrl: "https://mail.example/code",
      note: "plain note",
    });

    expect(created).toMatchObject({
      email: "user@example.com",
      accountStatus: "plus",
      note: "plain note",
      hasEmailPassword: true,
      hasChatgptPassword: true,
      hasTotpSecret: true,
      hasEmailCodeUrl: true,
    });
    expect(created).not.toHaveProperty("emailPassword");
    expect(store.listAccounts()).toEqual([created]);
    expect(store.getAccount(created.id)).toMatchObject({
      emailPassword: "email-password",
      chatgptPassword: "chatgpt-password",
      totpSecret: "totp-secret",
      emailCodeUrl: "https://mail.example/code",
    });

    const rawDb = new Database(path, { readonly: true });
    const raw = rawDb.prepare("SELECT * FROM backup_accounts").get() as Record<string, unknown>;
    expect(raw.email).toBe("user@example.com");
    expect(raw.account_status).toBe("plus");
    expect(raw.note).toBe("plain note");
    for (const column of ["email_password", "chatgpt_password", "totp_secret", "email_code_url"]) {
      expect(raw[column]).toMatch(/^v1:/);
    }
    expect(JSON.stringify(raw)).not.toContain("email-password");
    expect(JSON.stringify(raw)).not.toContain("chatgpt-password");
    expect(JSON.stringify(raw)).not.toContain("totp-secret");
    rawDb.close();
  });

  it("defaults existing databases and new accounts to unregistered status", () => {
    const { store } = createLegacyStore();

    expect(store.getAccount("legacy-account")).toMatchObject({
      email: "legacy@example.com",
      accountStatus: "unregistered",
    });
    expect(store.createAccount({ email: "new@example.com" })).toMatchObject({
      accountStatus: "unregistered",
    });
  });

  it("preserves omitted secrets and removes explicit null secrets", () => {
    const { store } = createStore();
    const account = store.createAccount({
      email: "old@example.com",
      emailPassword: "keep-me",
      totpSecret: "remove-me",
    });

    store.updateAccount(account.id, { email: "new@example.com", accountStatus: "pro", totpSecret: null });
    expect(store.getAccount(account.id)).toMatchObject({
      email: "new@example.com",
      accountStatus: "pro",
      emailPassword: "keep-me",
      totpSecret: null,
      hasEmailPassword: true,
      hasTotpSecret: false,
    });
    expect(store.updateAccount(account.id, { note: null })?.note).toBe("");
  });

  it("rejects a valid-length wrong key before allowing access or writes", () => {
    const { store, path } = createStore();
    store.createAccount({ email: "user@example.com", emailPassword: "keep-me" });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    expect(() => new BackupResourceStore(path, new BackupSecretCipher(randomBytes(32))))
      .toThrow();
  });

  it("does not overwrite a row when existing ciphertext fails authentication", () => {
    const { store, path } = createStore();
    const account = store.createAccount({ email: "user@example.com", emailPassword: "keep-me" });
    const rawDb = new Database(path);
    rawDb.prepare("UPDATE backup_accounts SET email_password = ? WHERE id = ?")
      .run("v1:tampered:authentication:payload", account.id);
    const before = rawDb.prepare("SELECT * FROM backup_accounts WHERE id = ?").get(account.id);

    expect(() => store.updateAccount(account.id, { email: "changed@example.com" })).toThrow();
    const after = rawDb.prepare("SELECT * FROM backup_accounts WHERE id = ?").get(account.id);
    expect(after).toEqual(before);
    rawDb.close();
  });

  it("increments phone use count atomically and supports phone CRUD", async () => {
    const { store } = createStore();
    const phone = store.createPhone({ phoneNumber: "+15555550123", note: "primary" });
    expect(phone.useCount).toBe(0);

    const used = await Promise.all(Array.from({ length: 20 }, async () => store.usePhone(phone.id)));
    expect(used.every(Boolean)).toBe(true);
    expect(store.getPhone(phone.id)?.useCount).toBe(20);
    expect(store.updatePhone(phone.id, { note: null, useCount: 4 })).toMatchObject({ useCount: 4, note: "" });
    expect(store.deletePhone(phone.id)).toBe(true);
    expect(store.getPhone(phone.id)).toBeNull();
  });
});
