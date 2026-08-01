import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function decodeKey(encoded: string, source: string): Buffer {
  const value = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${source} must be a base64-encoded 32-byte key`);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== value) {
    throw new Error(`${source} must be a base64-encoded 32-byte key`);
  }
  return key;
}

export function loadBackupEncryptionKey(
  keyPath: string,
  options: { allowCreate?: boolean } = {},
): Buffer {
  const environmentKey = process.env.CODEX_PROXY_BACKUP_KEY;
  if (environmentKey?.trim()) {
    return decodeKey(environmentKey, "CODEX_PROXY_BACKUP_KEY");
  }

  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!existsSync(keyPath) && options.allowCreate === false) {
    throw new Error("Backup resource key file is missing for an existing database");
  }
  try {
    const generated = randomBytes(KEY_BYTES).toString("base64");
    writeFileSync(keyPath, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "EEXIST") throw error;
  }
  chmodSync(keyPath, 0o600);
  return decodeKey(readFileSync(keyPath, "utf8"), "backup resource key file");
}

export class BackupSecretCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error("Backup encryption key must be 32 bytes");
  }

  encrypt(value: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
  }

  decrypt(value: string): string {
    const parts = value.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Unsupported backup ciphertext version");
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const encrypted = Buffer.from(parts[3], "base64");
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("Invalid backup ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}
