import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BackupSecretCipher } from "@src/backup-resources/crypto.js";

export interface LegacyV0DatabaseHandle {
  db: Database.Database;
  path: string;
  cipher: BackupSecretCipher;
}

export interface LegacyV0Options {
  includeKeyCheck?: boolean;
  insertAccount?: { id: string; email: string };
}

export function createLegacyV0Database(
  path: string,
  cipher: BackupSecretCipher,
  options: LegacyV0Options = {},
): LegacyV0DatabaseHandle {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE backup_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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

  if (options.includeKeyCheck !== false) {
    db.prepare("INSERT INTO backup_metadata (key, value) VALUES (?, ?)")
      .run("encryption_key_check", cipher.encrypt("codex-proxy-backup-resources-v1"));
  }

  if (options.insertAccount) {
    db.prepare(`
      INSERT INTO backup_accounts (id, email, created_at, updated_at)
      VALUES (?, ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run(options.insertAccount.id, options.insertAccount.email);
  }

  return { db, path, cipher };
}

export function closeLegacyV0Database(handle: LegacyV0DatabaseHandle): void {
  handle.db.close();
}
