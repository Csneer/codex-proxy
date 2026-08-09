import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Mode = "backup" | "restore";

interface BackupCliOptions {
  mode: Mode;
  database: string;
  destination?: string;
  source?: string;
  json: boolean;
}

function parseArgs(argv: string[]): BackupCliOptions {
  const opts: BackupCliOptions = {
    mode: "backup",
    database: process.env.CODEX_PROXY_BACKUP_DB ?? "",
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "backup") opts.mode = "backup";
    else if (arg === "restore") opts.mode = "restore";
    else if (arg === "--database") opts.database = argv[++i];
    else if (arg === "--destination") opts.destination = argv[++i];
    else if (arg === "--source") opts.source = argv[++i];
    else if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage:",
          "  account-factory-backup backup [--database PATH] [--destination PATH] [--json]",
          "  account-factory-backup restore --source PATH [--database PATH] [--json]",
          "",
          "Subcommands:",
          "  backup   Copy <database> to a timestamped snapshot using the SQLite Online Backup API.",
          "  restore  Overwrite <database> from a previously verified snapshot.",
          "",
          "Options:",
          "  --database PATH       Live backup-resources.sqlite (default: <dataDir>/backup-resources.sqlite)",
          "  --destination PATH    Output path for backup (default: <dataDir>/backups/backup-resources-<ts>.sqlite)",
          "  --source PATH         Snapshot to restore from (required for restore)",
          "  --json                Emit JSON result to stdout",
          "",
          "Env:",
          "  CODEX_PROXY_BACKUP_DB     Override database path",
          "  CODEX_PROXY_DATA_DIR      Override data directory",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  if (opts.mode === "restore" && !opts.source) {
    process.stderr.write("restore requires --source PATH\n");
    process.exit(2);
  }
  return opts;
}

function resolveDataDir(): string {
  const override = process.env.CODEX_PROXY_DATA_DIR;
  if (override && override.trim()) return resolve(override);
  const pkgRoot = resolve(new URL(".", import.meta.url).pathname, "..");
  return resolve(pkgRoot, "data");
}

function resolveDatabasePath(opts: BackupCliOptions): string {
  if (opts.database) return resolve(opts.database);
  return resolve(resolveDataDir(), "backup-resources.sqlite");
}

function timestampUtc(now = new Date()): string {
  const iso = now.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function defaultBackupDestination(): string {
  const dataDir = resolveDataDir();
  const backupsDir = resolve(dataDir, "backups");
  return join(backupsDir, `backup-resources-${timestampUtc()}.sqlite`);
}

interface IntegrityResult {
  integrityCheck: "ok" | "failed";
  integrityLog: string[];
  tables: Array<{ name: string; rows: number }>;
}

function verifySnapshot(path: string): IntegrityResult {
  if (!existsSync(path)) {
    throw new Error(`Snapshot does not exist after copy: ${path}`);
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const integrityLog = integrity.map((row) => row.integrity_check);
    const integrityCheck = integrityLog.length === 1 && integrityLog[0] === "ok" ? "ok" : "failed";
    const tableRows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tables: Array<{ name: string; rows: number }> = [];
    for (const { name } of tableRows) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number };
      tables.push({ name, rows: row.n });
    }
    return { integrityCheck, integrityLog, tables };
  } finally {
    db.close();
  }
}

async function performBackup(opts: BackupCliOptions): Promise<{
  source: string;
  destination: string;
  bytes: number;
  createdAt: string;
  integrity: IntegrityResult;
}> {
  const source = resolveDatabasePath(opts);
  if (!existsSync(source)) {
    throw new Error(`Database file does not exist: ${source}`);
  }
  const destination = resolve(opts.destination ?? defaultBackupDestination());
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  if (existsSync(destination)) {
    throw new Error(`Destination already exists; refusing to overwrite: ${destination}`);
  }

  const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(destination);
  } finally {
    sourceDb.close();
  }

  const integrity = verifySnapshot(destination);
  const bytes = statSync(destination).size;
  return {
    source,
    destination,
    bytes,
    createdAt: new Date().toISOString(),
    integrity,
  };
}

async function performRestore(opts: BackupCliOptions): Promise<{
  source: string;
  destination: string;
  bytes: number;
  integrity: IntegrityResult;
  tempPath: string;
  quarantinePath: string | null;
}> {
  const destination = resolveDatabasePath(opts);
  const source = resolve(opts.source!);
  if (!existsSync(source)) {
    throw new Error(`Source snapshot does not exist: ${source}`);
  }
  const sourceSize = statSync(source).size;
  if (sourceSize === 0) {
    throw new Error(`Source snapshot is empty: ${source}`);
  }
  const sourceIntegrity = verifySnapshot(source);
  if (sourceIntegrity.integrityCheck !== "ok") {
    throw new Error(`Source snapshot failed integrity check; refusing to restore: ${source}`);
  }

  mkdirSync(dirname(destination), { recursive: true });
  const stamp = timestampUtc();
  const tempPath = `${destination}.restore-tmp-${stamp}`;
  if (existsSync(tempPath)) {
    throw new Error(`Restore temp path already exists; refusing to overwrite: ${tempPath}`);
  }

  try {
    copyFileSync(source, tempPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }

  const tempIntegrity = verifySnapshot(tempPath);
  if (tempIntegrity.integrityCheck !== "ok") {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw new Error(
      `Restored snapshot failed integrity check at temp path; temp file removed: ${tempPath}`,
    );
  }

  let quarantinePath: string | null = null;
  if (existsSync(destination)) {
    quarantinePath = `${destination}.quarantine-${stamp}`;
    try {
      renameSync(destination, quarantinePath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore cleanup failure
      }
      throw new Error(
        `Failed to quarantine existing live database: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    renameSync(tempPath, destination);
  } catch (error) {
    if (quarantinePath !== null && !existsSync(destination)) {
      try {
        renameSync(quarantinePath, destination);
        quarantinePath = null;
      } catch {
        // preserve the quarantine path in the thrown error for manual recovery
      }
    }
    throw new Error(
      `Failed to promote restored snapshot to live path: ${error instanceof Error ? error.message : String(error)}; quarantine=${quarantinePath ?? "none"}`,
    );
  }

  const integrity = verifySnapshot(destination);
  const bytes = statSync(destination).size;
  return { source, destination, bytes, integrity, tempPath, quarantinePath };
}

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  try {
    if (opts.mode === "backup") {
      const result = await performBackup(opts);
      if (result.integrity.integrityCheck !== "ok") {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              { ok: false, error: "integrity_check failed", result },
              null,
              2,
            ) + "\n",
          );
        } else {
          process.stderr.write(
            `account-factory-backup: integrity_check failed for ${result.destination}\n`,
          );
        }
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, mode: "backup", result }, null, 2) + "\n");
      } else {
        process.stdout.write(
          [
            "backup OK",
            `  source:        ${result.source}`,
            `  destination:   ${result.destination}`,
            `  bytes:         ${result.bytes}`,
            `  createdAt:     ${result.createdAt}`,
            `  integrity:     ${result.integrity.integrityCheck}`,
            "  tables:",
            ...result.integrity.tables.map((t) => `    - ${t.name}: ${t.rows} row(s)`),
            "",
          ].join("\n"),
        );
      }
      return;
    }

    const result = await performRestore(opts);
    if (result.integrity.integrityCheck !== "ok") {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: false, error: "integrity_check failed", result }, null, 2) + "\n",
        );
      } else {
        process.stderr.write(
          `account-factory-restore: integrity_check failed for ${result.destination}\n`,
        );
      }
      process.exit(1);
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, mode: "restore", result }, null, 2) + "\n");
    } else {
      process.stdout.write(
        [
          "restore OK",
          `  source:        ${result.source}`,
          `  destination:   ${result.destination}`,
          `  bytes:         ${result.bytes}`,
          `  integrity:     ${result.integrity.integrityCheck}`,
          `  tempPath:      ${result.tempPath} (promoted)`,
          result.quarantinePath
            ? `  quarantine:    ${result.quarantinePath} (previous live db)`
            : "  quarantine:    (none, destination did not exist)",
          "  tables:",
          ...result.integrity.tables.map((t) => `    - ${t.name}: ${t.rows} row(s)`),
          "",
        ].join("\n"),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
    } else {
      process.stderr.write(`account-factory-${opts.mode}: ${message}\n`);
    }
    process.exit(2);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main(process.argv.slice(2));
}

export { main as accountFactoryBackupMain, performBackup, performRestore, verifySnapshot };
