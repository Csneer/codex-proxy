import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BackupSecretCipher, loadBackupEncryptionKey } from "@src/backup-resources/crypto.js";

const originalEnvironmentKey = process.env.CODEX_PROXY_BACKUP_KEY;

afterEach(() => {
  if (originalEnvironmentKey === undefined) delete process.env.CODEX_PROXY_BACKUP_KEY;
  else process.env.CODEX_PROXY_BACKUP_KEY = originalEnvironmentKey;
});

describe("backup resource encryption", () => {
  it("round-trips versioned AES-256-GCM ciphertext without embedding plaintext", () => {
    const cipher = new BackupSecretCipher(randomBytes(32));
    const encrypted = cipher.encrypt("top-secret-value");

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain("top-secret-value");
    expect(cipher.decrypt(encrypted)).toBe("top-secret-value");
    const [version, iv, tag, payload] = encrypted.split(":");
    const tamperedTag = `${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}`;
    expect(() => cipher.decrypt([version, iv, tamperedTag, payload].join(":"))).toThrow();
  });

  it("creates and reuses a 0600 key file", () => {
    process.env.CODEX_PROXY_BACKUP_KEY = "";
    const dir = mkdtempSync(join(tmpdir(), "backup-key-"));
    const path = join(dir, "backup-resources.key");

    const first = loadBackupEncryptionKey(path);
    const second = loadBackupEncryptionKey(path);

    expect(second).toEqual(first);
    expect(first).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(path, "utf8").trim(), "base64")).toEqual(first);
  });

  it("gives the environment key precedence and rejects malformed keys", () => {
    const key = randomBytes(32);
    process.env.CODEX_PROXY_BACKUP_KEY = key.toString("base64");
    expect(loadBackupEncryptionKey("/path/that/must/not/be/read")).toEqual(key);

    process.env.CODEX_PROXY_BACKUP_KEY = "not-a-key";
    expect(() => loadBackupEncryptionKey("/unused")).toThrow(/32-byte key/);
  });

  it("does not generate a replacement key for an existing database", () => {
    delete process.env.CODEX_PROXY_BACKUP_KEY;
    const dir = mkdtempSync(join(tmpdir(), "backup-key-missing-"));
    const databasePath = join(dir, "backup-resources.sqlite");
    const keyPath = join(dir, "backup-resources.key");
    writeFileSync(databasePath, "existing database marker");

    expect(() => loadBackupEncryptionKey(keyPath, { allowCreate: false }))
      .toThrow(/missing for an existing database/);
    expect(existsSync(keyPath)).toBe(false);
  });
});
