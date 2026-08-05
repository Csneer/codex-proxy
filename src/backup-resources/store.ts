import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { BackupSecretCipher } from "./crypto.js";
import type {
  BackupAccountDetail,
  BackupAccountInput,
  BackupAccountPatch,
  BackupAccountStatus,
  BackupAccountSummary,
  BackupPhone,
  BackupPhoneInput,
  BackupPhonePatch,
} from "./types.js";

interface AccountRow {
  id: string;
  email: string;
  account_status: BackupAccountStatus;
  email_password: string | null;
  chatgpt_password: string | null;
  totp_secret: string | null;
  email_code_url: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface PhoneRow {
  id: string;
  phone: string;
  use_count: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

const SECRET_COLUMNS = {
  emailPassword: "email_password",
  chatgptPassword: "chatgpt_password",
  totpSecret: "totp_secret",
  emailCodeUrl: "email_code_url",
} as const;
const KEY_CHECK_NAME = "encryption_key_check";
const KEY_CHECK_VALUE = "codex-proxy-backup-resources-v1";
const DEFAULT_ACCOUNT_STATUS: BackupAccountStatus = "unregistered";

function now(): string {
  return new Date().toISOString();
}

function accountSummary(row: AccountRow): BackupAccountSummary {
  return {
    id: row.id,
    email: row.email,
    accountStatus: row.account_status,
    note: row.note ?? "",
    hasEmailPassword: row.email_password !== null,
    hasChatgptPassword: row.chatgpt_password !== null,
    hasTotpSecret: row.totp_secret !== null,
    hasEmailCodeUrl: row.email_code_url !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function phoneValue(row: PhoneRow): BackupPhone {
  return {
    id: row.id,
    phoneNumber: row.phone,
    useCount: row.use_count,
    note: row.note ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BackupResourceStore {
  private readonly db: Database.Database;

  constructor(path: string, private readonly cipher: BackupSecretCipher) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS backup_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backup_accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          account_status TEXT NOT NULL DEFAULT 'unregistered'
            CHECK (account_status IN ('plus', 'free', 'unregistered', 'pro')),
          email_password TEXT,
          chatgpt_password TEXT,
          totp_secret TEXT,
          email_code_url TEXT,
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backup_phones (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL,
          use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.ensureAccountStatusColumn();
      this.verifyEncryptionKey();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  listAccounts(): BackupAccountSummary[] {
    const rows = this.db.prepare("SELECT * FROM backup_accounts ORDER BY created_at DESC, id DESC").all() as AccountRow[];
    return rows.map(accountSummary);
  }

  getAccount(id: string): BackupAccountDetail | null {
    const row = this.db.prepare("SELECT * FROM backup_accounts WHERE id = ?").get(id) as AccountRow | undefined;
    if (!row) return null;
    return {
      ...accountSummary(row),
      emailPassword: row.email_password === null ? null : this.cipher.decrypt(row.email_password),
      chatgptPassword: row.chatgpt_password === null ? null : this.cipher.decrypt(row.chatgpt_password),
      totpSecret: row.totp_secret === null ? null : this.cipher.decrypt(row.totp_secret),
      emailCodeUrl: row.email_code_url === null ? null : this.cipher.decrypt(row.email_code_url),
    };
  }

  createAccount(input: BackupAccountInput): BackupAccountSummary {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO backup_accounts (
        id, email, account_status, email_password, chatgpt_password, totp_secret, email_code_url, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.email,
      input.accountStatus ?? DEFAULT_ACCOUNT_STATUS,
      this.encryptNullable(input.emailPassword),
      this.encryptNullable(input.chatgptPassword),
      this.encryptNullable(input.totpSecret),
      this.encryptNullable(input.emailCodeUrl),
      input.note ?? null,
      timestamp,
      timestamp,
    );
    return this.getAccountSummary(id)!;
  }

  updateAccount(id: string, patch: BackupAccountPatch): BackupAccountSummary | null {
    const update = this.db.transaction((): BackupAccountSummary | null => {
      // Authenticate every existing encrypted field before changing any bytes.
      // This prevents a wrong key or a tampered row from being partially
      // overwritten into an unrecoverable mixed-key record.
      if (!this.getAccount(id)) return null;
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (patch.email !== undefined) {
        assignments.push("email = ?");
        values.push(patch.email);
      }
      if (patch.accountStatus !== undefined) {
        assignments.push("account_status = ?");
        values.push(patch.accountStatus);
      }
      for (const [field, column] of Object.entries(SECRET_COLUMNS) as Array<[keyof typeof SECRET_COLUMNS, string]>) {
        if (patch[field] !== undefined) {
          assignments.push(`${column} = ?`);
          values.push(this.encryptNullable(patch[field]));
        }
      }
      if (patch.note !== undefined) {
        assignments.push("note = ?");
        values.push(patch.note);
      }
      if (assignments.length > 0) {
        assignments.push("updated_at = ?");
        values.push(now(), id);
        this.db.prepare(`UPDATE backup_accounts SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
      }
      return this.getAccountSummary(id);
    });
    return update();
  }

  deleteAccount(id: string): boolean {
    return this.db.prepare("DELETE FROM backup_accounts WHERE id = ?").run(id).changes > 0;
  }

  listPhones(): BackupPhone[] {
    const rows = this.db.prepare("SELECT * FROM backup_phones ORDER BY created_at DESC, id DESC").all() as PhoneRow[];
    return rows.map(phoneValue);
  }

  getPhone(id: string): BackupPhone | null {
    const row = this.db.prepare("SELECT * FROM backup_phones WHERE id = ?").get(id) as PhoneRow | undefined;
    return row ? phoneValue(row) : null;
  }

  createPhone(input: BackupPhoneInput): BackupPhone {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO backup_phones (id, phone, use_count, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.phoneNumber, input.useCount ?? 0, input.note ?? null, timestamp, timestamp);
    return this.getPhone(id)!;
  }

  updatePhone(id: string, patch: BackupPhonePatch): BackupPhone | null {
    if (!this.getPhone(id)) return null;
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.phoneNumber !== undefined) {
      assignments.push("phone = ?");
      values.push(patch.phoneNumber);
    }
    if (patch.useCount !== undefined) {
      assignments.push("use_count = ?");
      values.push(patch.useCount);
    }
    if (patch.note !== undefined) {
      assignments.push("note = ?");
      values.push(patch.note);
    }
    if (assignments.length > 0) {
      assignments.push("updated_at = ?");
      values.push(now(), id);
      this.db.prepare(`UPDATE backup_phones SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getPhone(id);
  }

  usePhone(id: string): BackupPhone | null {
    const row = this.db.prepare(`
      UPDATE backup_phones
      SET use_count = use_count + 1, updated_at = ?
      WHERE id = ?
      RETURNING *
    `).get(now(), id) as PhoneRow | undefined;
    return row ? phoneValue(row) : null;
  }

  deletePhone(id: string): boolean {
    return this.db.prepare("DELETE FROM backup_phones WHERE id = ?").run(id).changes > 0;
  }

  private encryptNullable(value: string | null | undefined): string | null {
    return value == null ? null : this.cipher.encrypt(value);
  }

  private ensureAccountStatusColumn(): void {
    const columns = this.db.pragma("table_info(backup_accounts)") as Array<{ name: string }>;
    if (columns.some((column) => column.name === "account_status")) return;
    this.db.exec(`
      ALTER TABLE backup_accounts
      ADD COLUMN account_status TEXT NOT NULL DEFAULT 'unregistered'
        CHECK (account_status IN ('plus', 'free', 'unregistered', 'pro'))
    `);
  }

  private verifyEncryptionKey(): void {
    const row = this.db
      .prepare("SELECT value FROM backup_metadata WHERE key = ?")
      .get(KEY_CHECK_NAME) as { value: string } | undefined;
    if (row) {
      if (this.cipher.decrypt(row.value) !== KEY_CHECK_VALUE) {
        throw new Error("Backup resource encryption key verification failed");
      }
      return;
    }

    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM backup_accounts) +
        (SELECT COUNT(*) FROM backup_phones) AS total
    `).get() as { total: number };
    if (counts.total > 0) {
      throw new Error("Backup resource encryption key verification metadata is missing");
    }
    this.db.prepare("INSERT INTO backup_metadata (key, value) VALUES (?, ?)")
      .run(KEY_CHECK_NAME, this.cipher.encrypt(KEY_CHECK_VALUE));
  }

  private getAccountSummary(id: string): BackupAccountSummary | null {
    const row = this.db.prepare("SELECT * FROM backup_accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? accountSummary(row) : null;
  }
}
