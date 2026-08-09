import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadBackupEncryptionKey, BackupSecretCipher } from "../src/backup-resources/crypto.js";
import {
  BACKUP_RESOURCES_SCHEMA_VERSION,
  BACKUP_RESOURCES_SCHEMA_VERSION_KEY,
  type PreflightConflictRecord,
  type PreflightReport,
  type PreflightUndecryptableRecord,
} from "../src/backup-resources/types.js";

const KEY_CHECK_NAME = "encryption_key_check";
const KEY_CHECK_VALUE = "codex-proxy-backup-resources-v1";
const SECRET_COLUMNS = [
  "email_password",
  "chatgpt_password",
  "totp_secret",
  "email_code_url",
] as const;

interface CliOptions {
  database: string;
  keyFile: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    database: process.env.CODEX_PROXY_BACKUP_DB ?? "",
    keyFile: process.env.CODEX_PROXY_BACKUP_KEY_FILE ?? "",
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--database") opts.database = argv[++i];
    else if (arg === "--key-file") opts.keyFile = argv[++i];
    else if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: account-factory-migration-check [--database PATH] [--key-file PATH] [--json]",
          "  --database PATH  Path to backup-resources.sqlite (default: <dataDir>/backup-resources.sqlite)",
          "  --key-file PATH  Path to base64 32-byte AES key (default: <dataDir>/backup-resources.key)",
          "  --json           Emit report as JSON to stdout",
          "",
          "Env:",
          "  CODEX_PROXY_BACKUP_DB           Override database path",
          "  CODEX_PROXY_BACKUP_KEY_FILE     Override key file path",
          "  CODEX_PROXY_BACKUP_KEY          Inline base64 key (skips key file)",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return opts;
}

function resolveDataDir(): string {
  const override = process.env.CODEX_PROXY_DATA_DIR;
  if (override && override.trim()) return resolve(override);
  const pkgRoot = resolve(new URL(".", import.meta.url).pathname, "..");
  return resolve(pkgRoot, "data");
}

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

function readEncryptionKeyCheck(db: Database.Database): string | null {
  if (!tableExists(db, "backup_metadata")) return null;
  const row = db
    .prepare("SELECT value FROM backup_metadata WHERE key = ?")
    .get(KEY_CHECK_NAME) as { value: string } | undefined;
  return row ? row.value : null;
}

function readRecordedSchemaVersion(db: Database.Database): number | null {
  if (!tableExists(db, "backup_metadata")) return null;
  const row = db
    .prepare("SELECT value FROM backup_metadata WHERE key = ?")
    .get(BACKUP_RESOURCES_SCHEMA_VERSION_KEY) as { value: string } | undefined;
  if (!row) return null;
  if (!/^\d+$/.test(row.value)) {
    throw new Error(`Invalid recorded schema version: ${row.value}`);
  }
  const parsed = Number(row.value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid recorded schema version: ${row.value}`);
  }
  return parsed;
}

function inferSchemaVersion(db: Database.Database): number {
  const recorded = readRecordedSchemaVersion(db);
  if (recorded !== null) return recorded;
  if (!tableExists(db, "backup_accounts")) return BACKUP_RESOURCES_SCHEMA_VERSION;
  if (!columnExists(db, "backup_accounts", "account_status")) return 0;
  if (!columnExists(db, "backup_accounts", "lifecycle_status")) return 1;
  return BACKUP_RESOURCES_SCHEMA_VERSION;
}

interface AccountRow {
  id: string;
  email: string;
  account_status: string | null;
  email_password: string | null;
  chatgpt_password: string | null;
  totp_secret: string | null;
  email_code_url: string | null;
  email_normalized?: string | null;
  lifecycle_status?: string | null;
}

function loadAccountRows(db: Database.Database): AccountRow[] {
  if (!tableExists(db, "backup_accounts")) return [];
  const hasAccountStatus = columnExists(db, "backup_accounts", "account_status");
  const hasNormalized = columnExists(db, "backup_accounts", "email_normalized");
  const hasLifecycle = columnExists(db, "backup_accounts", "lifecycle_status");
  const selectExtras = [
    hasAccountStatus ? "account_status" : "'unregistered' AS account_status",
    hasNormalized ? "email_normalized" : "NULL AS email_normalized",
    hasLifecycle ? "lifecycle_status" : "NULL AS lifecycle_status",
  ].join(", ");
  return db
    .prepare(
      `SELECT id, email, ${selectExtras}, email_password, chatgpt_password, totp_secret, email_code_url FROM backup_accounts`,
    )
    .all() as AccountRow[];
}

function findConflicts(rows: AccountRow[]): PreflightConflictRecord[] {
  const byNormalized = new Map<string, AccountRow[]>();
  for (const row of rows) {
    const normalized =
      row.email_normalized !== null && row.email_normalized !== undefined
        ? row.email_normalized
        : normalizeEmail(row.email);
    if (!normalized) continue;
    const bucket = byNormalized.get(normalized) ?? [];
    bucket.push(row);
    byNormalized.set(normalized, bucket);
  }
  const conflicts: PreflightConflictRecord[] = [];
  for (const [normalized, bucket] of byNormalized) {
    if (bucket.length < 2) continue;
    for (const row of bucket) {
      conflicts.push({
        id: row.id,
        email: row.email,
        emailNormalized: normalized,
        accountStatus: row.account_status ?? "unknown",
        lifecycleStatus: row.lifecycle_status ?? null,
      });
    }
  }
  conflicts.sort((a, b) =>
    a.emailNormalized === b.emailNormalized
      ? a.email.localeCompare(b.email)
      : a.emailNormalized.localeCompare(b.emailNormalized),
  );
  return conflicts;
}

function findUndecryptable(
  rows: AccountRow[],
  cipher: BackupSecretCipher,
): PreflightUndecryptableRecord[] {
  const out: PreflightUndecryptableRecord[] = [];
  for (const row of rows) {
    for (const column of SECRET_COLUMNS) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      try {
        cipher.decrypt(value);
      } catch (error) {
        out.push({
          id: row.id,
          email: row.email,
          column,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return out;
}

function countPhones(db: Database.Database): number {
  if (!tableExists(db, "backup_phones")) return 0;
  const row = db.prepare("SELECT COUNT(*) AS n FROM backup_phones").get() as { n: number };
  return row.n;
}

function runPreflight(opts: CliOptions): PreflightReport {
  const dataDir = resolveDataDir();
  const databasePath = opts.database || resolve(dataDir, "backup-resources.sqlite");
  const keyFilePath = opts.keyFile || resolve(dataDir, "backup-resources.key");

  const notes: string[] = [];
  notes.push(`database: ${databasePath}`);
  notes.push(`keyFile: ${keyFilePath}`);

  if (!existsSync(databasePath)) {
    throw new Error(`Database file does not exist: ${databasePath}`);
  }
  const dbStat = statSync(databasePath);
  if (!dbStat.isFile() || dbStat.size === 0) {
    throw new Error(`Database file is empty or not a regular file: ${databasePath}`);
  }

  let keyBuffer: Buffer;
  try {
    keyBuffer = loadBackupEncryptionKey(keyFilePath, { allowCreate: false });
  } catch (error) {
    throw new Error(
      `Failed to load backup encryption key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const cipher = new BackupSecretCipher(keyBuffer);

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    const currentVersion = inferSchemaVersion(db);
    const encryptionKeyCiphertext = readEncryptionKeyCheck(db);
    let encryptionKeyOk = false;
    if (encryptionKeyCiphertext === null) {
      const accounts = tableExists(db, "backup_accounts")
        ? (db.prepare("SELECT COUNT(*) AS n FROM backup_accounts").get() as { n: number }).n
        : 0;
      const phones = countPhones(db);
      if (accounts === 0 && phones === 0) {
        encryptionKeyOk = true;
        notes.push("encryption_key_check absent but database is empty; migration will seed it");
      } else {
        notes.push("encryption_key_check missing on non-empty database");
      }
    } else {
      try {
        const decrypted = cipher.decrypt(encryptionKeyCiphertext);
        encryptionKeyOk = decrypted === KEY_CHECK_VALUE;
        if (!encryptionKeyOk) {
          notes.push("encryption_key_check present but plaintext mismatch");
        }
      } catch (error) {
        notes.push(
          `encryption_key_check decryption failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const accountRows = loadAccountRows(db);
    const conflicts = encryptionKeyOk ? findConflicts(accountRows) : [];
    const undecryptable = encryptionKeyOk ? findUndecryptable(accountRows, cipher) : [];

    const totalAccounts = accountRows.length;
    const totalPhones = countPhones(db);

    if (currentVersion > BACKUP_RESOURCES_SCHEMA_VERSION) {
      notes.push(
        `preflight blocked: schema version ${currentVersion} is newer than supported ${BACKUP_RESOURCES_SCHEMA_VERSION}`,
      );
    } else if (currentVersion === BACKUP_RESOURCES_SCHEMA_VERSION) {
      notes.push(`schema already at version ${currentVersion}; migration is a no-op`);
    }

    const safetyChecksPass =
      encryptionKeyOk && conflicts.length === 0 && undecryptable.length === 0;
    const readyForMigration =
      safetyChecksPass && currentVersion < BACKUP_RESOURCES_SCHEMA_VERSION;
    const alreadySafeAtTarget =
      safetyChecksPass && currentVersion === BACKUP_RESOURCES_SCHEMA_VERSION;

    if (currentVersion > BACKUP_RESOURCES_SCHEMA_VERSION) {
      // The newer-schema note above is the terminal preflight result.
    } else if (alreadySafeAtTarget) {
      notes.push("preflight passed; target schema version already reached");
    } else if (!encryptionKeyOk) {
      notes.push("preflight blocked: encryption key verification failed");
    } else if (conflicts.length > 0) {
      notes.push(`preflight blocked: ${conflicts.length} row(s) share normalized email(s)`);
    } else if (undecryptable.length > 0) {
      notes.push(`preflight blocked: ${undecryptable.length} secret(s) failed to decrypt`);
    } else {
      notes.push("preflight passed; migration may proceed");
    }

    return {
      schemaVersionCurrent: currentVersion,
      schemaVersionTarget: BACKUP_RESOURCES_SCHEMA_VERSION,
      encryptionKeyOk,
      totalAccounts,
      totalPhones,
      conflicts,
      undecryptable,
      readyForMigration,
      notes,
    };
  } finally {
    db.close();
  }
}

function main(argv: string[]): void {
  const opts = parseArgs(argv);
  let report: PreflightReport;
  try {
    report = runPreflight(opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: false,
            error: message,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stderr.write(`account-factory-migration-check: ${message}\n`);
    }
    process.exit(2);
  }

  const safetyChecksPass =
    report.encryptionKeyOk &&
    report.conflicts.length === 0 &&
    report.undecryptable.length === 0;
  const supportedSchema =
    report.schemaVersionCurrent <= BACKUP_RESOURCES_SCHEMA_VERSION;
  const preflightPassed =
    safetyChecksPass &&
    supportedSchema &&
    (report.readyForMigration ||
      report.schemaVersionCurrent === BACKUP_RESOURCES_SCHEMA_VERSION);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: preflightPassed, report }, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(report));
  }

  process.exit(preflightPassed ? 0 : 1);
}

function formatReport(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push("account-factory migration preflight");
  lines.push("===================================");
  lines.push(`schema version:  ${report.schemaVersionCurrent} -> ${report.schemaVersionTarget}`);
  lines.push(`encryption key:  ${report.encryptionKeyOk ? "OK" : "FAILED"}`);
  lines.push(`accounts:        ${report.totalAccounts}`);
  lines.push(`phones:          ${report.totalPhones}`);
  lines.push(`conflicts:       ${report.conflicts.length}`);
  lines.push(`undecryptable:   ${report.undecryptable.length}`);
  lines.push(`ready:           ${report.readyForMigration ? "YES" : "NO"}`);
  lines.push("");
  if (report.conflicts.length > 0) {
    lines.push("Conflicts (duplicate normalized emails):");
    for (const c of report.conflicts) {
      lines.push(
        `  - id=${c.id} email=${c.email} normalized=${c.emailNormalized} status=${c.accountStatus}`,
      );
    }
    lines.push("");
  }
  if (report.undecryptable.length > 0) {
    lines.push("Undecryptable secrets:");
    for (const u of report.undecryptable) {
      lines.push(`  - id=${u.id} email=${u.email} column=${u.column} error=${u.error}`);
    }
    lines.push("");
  }
  lines.push("Notes:");
  for (const note of report.notes) lines.push(`  - ${note}`);
  lines.push("");
  return lines.join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2));
}

export { main as accountFactoryMigrationCheckMain, runPreflight };
