import Database from "better-sqlite3";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { BackupSecretCipher } from "./crypto.js";
import {
  ACCOUNT_FACTORY_LEASE_STATES,
  ACCOUNT_FACTORY_PROMOTION_MODES,
  ACCOUNT_FACTORY_PROMOTION_STATES,
  ACCOUNT_FACTORY_SOURCE_SYSTEMS,
  BACKUP_ACCOUNT_LIFECYCLE_STATUSES,
  BACKUP_RESOURCES_SCHEMA_VERSION,
  BACKUP_RESOURCES_SCHEMA_VERSION_KEY,
} from "./types.js";
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
    const existingDatabase = existsSync(path) && statSync(path).size > 0;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      if (existingDatabase) {
        this.verifyExistingEncryptionKey();
      }
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
      this.migrateSchema();
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
        id, email, email_normalized, account_status, email_password, chatgpt_password, totp_secret, email_code_url, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.email,
      normalizeEmail(input.email),
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
        assignments.push("email = ?", "email_normalized = ?");
        values.push(patch.email, normalizeEmail(patch.email));
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

  private verifyExistingEncryptionKey(): void {
    const metadataExists = this.tableExists("backup_metadata");
    const row = metadataExists
      ? (this.db
          .prepare("SELECT value FROM backup_metadata WHERE key = ?")
          .get(KEY_CHECK_NAME) as { value: string } | undefined)
      : undefined;
    if (row) {
      if (this.cipher.decrypt(row.value) !== KEY_CHECK_VALUE) {
        throw new Error("Backup resource encryption key verification failed");
      }
      return;
    }
    if (this.countExistingResourceRows() > 0) {
      throw new Error("Backup resource encryption key verification metadata is missing");
    }
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | undefined;
    return Boolean(row);
  }

  private countExistingResourceRows(): number {
    let total = 0;
    for (const table of ["backup_accounts", "backup_phones"]) {
      if (!this.tableExists(table)) continue;
      const row = this.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
      total += row.total;
    }
    return total;
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

  private migrateSchema(): void {
    const current = this.readSchemaVersion();
    if (current > BACKUP_RESOURCES_SCHEMA_VERSION) {
      throw new Error(
        `Backup resource schema version ${current} is newer than supported version ${BACKUP_RESOURCES_SCHEMA_VERSION}`,
      );
    }
    if (current === BACKUP_RESOURCES_SCHEMA_VERSION) return;

    if (current < 1) {
      this.ensureAccountStatusColumn();
    }
    if (current < 2) {
      this.applySchemaV2();
    }

    this.writeSchemaVersion(BACKUP_RESOURCES_SCHEMA_VERSION);
  }

  private readSchemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM backup_metadata WHERE key = ?")
      .get(BACKUP_RESOURCES_SCHEMA_VERSION_KEY) as { value: string } | undefined;
    if (row) {
      if (!/^\d+$/.test(row.value)) {
        throw new Error(`Invalid backup resource schema version: ${row.value}`);
      }
      const parsed = Number(row.value);
      if (Number.isSafeInteger(parsed)) return parsed;
      throw new Error(`Invalid backup resource schema version: ${row.value}`);
    }
    if (!this.columnExists("backup_accounts", "account_status")) return 0;
    return 1;
  }

  private writeSchemaVersion(version: number): void {
    this.db
      .prepare(
        "INSERT INTO backup_metadata (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(BACKUP_RESOURCES_SCHEMA_VERSION_KEY, String(version));
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (this.columnExists(table, column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private applySchemaV2(): void {
    const lifecycleValues = BACKUP_ACCOUNT_LIFECYCLE_STATUSES.map((v) => `'${v}'`).join(", ");
    const sourceValues = ACCOUNT_FACTORY_SOURCE_SYSTEMS.map((v) => `'${v}'`).join(", ");
    const leaseStateValues = ACCOUNT_FACTORY_LEASE_STATES.map((v) => `'${v}'`).join(", ");
    const promotionModeValues = ACCOUNT_FACTORY_PROMOTION_MODES.map((v) => `'${v}'`).join(", ");
    const promotionStateValues = ACCOUNT_FACTORY_PROMOTION_STATES.map((v) => `'${v}'`).join(", ");

    const migration = this.db.transaction(() => {
      this.addColumnIfMissing(
        "backup_accounts",
        "lifecycle_status",
        `TEXT NOT NULL DEFAULT 'available' CHECK (lifecycle_status IN (${lifecycleValues}))`,
      );
      this.addColumnIfMissing("backup_accounts", "email_normalized", "TEXT");
      this.addColumnIfMissing("backup_accounts", "source_system", `TEXT CHECK (source_system IS NULL OR source_system IN (${sourceValues}))`);
      this.addColumnIfMissing("backup_accounts", "external_id", "TEXT");
      this.addColumnIfMissing("backup_accounts", "apple_label", "TEXT");
      this.addColumnIfMissing("backup_accounts", "source_active", "INTEGER NOT NULL DEFAULT 1");
      this.addColumnIfMissing("backup_accounts", "active_account_id", "TEXT");
      this.addColumnIfMissing("backup_accounts", "last_mail_synced_at", "TEXT");
      this.addColumnIfMissing("backup_accounts", "registration_started_at", "TEXT");
      this.addColumnIfMissing("backup_accounts", "registered_at", "TEXT");
      this.addColumnIfMissing("backup_accounts", "last_verified_at", "TEXT");
      this.addColumnIfMissing("backup_accounts", "last_error_code", "TEXT");
      this.addColumnIfMissing("backup_accounts", "revision", "INTEGER NOT NULL DEFAULT 0");
      this.addColumnIfMissing("backup_accounts", "last_source_revision", "TEXT");
      this.addColumnIfMissing("backup_accounts", "last_applied_operation_id", "TEXT");
      this.addColumnIfMissing("backup_accounts", "access_token", "TEXT");
      this.addColumnIfMissing("backup_accounts", "session_json", "TEXT");
      this.addColumnIfMissing("backup_accounts", "refresh_token", "TEXT");

      this.db.exec(
        "UPDATE backup_accounts " +
          "SET email_normalized = lower(trim(email)) " +
          "WHERE email_normalized IS NULL AND email IS NOT NULL",
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS account_factory_leases (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES backup_accounts(id),
          consumer_id TEXT NOT NULL,
          task_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL DEFAULT 'leased'
            CHECK (state IN (${leaseStateValues})),
          email_submission_committed INTEGER NOT NULL DEFAULT 0
            CHECK (email_submission_committed IN (0, 1)),
          email_submission_committed_at TEXT,
          claim_expires_at TEXT,
          failure_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS account_factory_promotions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL UNIQUE REFERENCES backup_accounts(id),
          idempotency_key TEXT NOT NULL UNIQUE,
          mode TEXT NOT NULL
            CHECK (mode IN (${promotionModeValues})),
          state TEXT NOT NULL DEFAULT 'planned'
            CHECK (state IN (${promotionStateValues})),
          core_account_id TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS account_factory_events (
          id TEXT PRIMARY KEY,
          account_id TEXT REFERENCES backup_accounts(id),
          task_id TEXT,
          event_type TEXT NOT NULL,
          error_code TEXT,
          created_at TEXT NOT NULL
        );
      `);

      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_backup_accounts_email_normalized " +
          "ON backup_accounts(email_normalized) WHERE email_normalized IS NOT NULL",
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_backup_accounts_source_external " +
          "ON backup_accounts(source_system, external_id) " +
          "WHERE source_system IS NOT NULL AND external_id IS NOT NULL",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_backup_accounts_lifecycle " +
          "ON backup_accounts(lifecycle_status)",
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_factory_leases_account_open " +
          "ON account_factory_leases(account_id) WHERE state IN ('leased', 'committed')",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_account_factory_events_account " +
          "ON account_factory_events(account_id, created_at)",
      );
    });
    migration();
  }
}
