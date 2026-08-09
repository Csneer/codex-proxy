import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";

const tempDirs: string[] = [];
const stores: BackupResourceStore[] = [];

function registeredAccount(options: { refreshToken?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "account-factory-promotion-"));
  tempDirs.push(dir);
  const path = join(dir, "backup-resources.sqlite");
  const cipher = createTestCipher();
  const store = new BackupResourceStore(path, cipher);
  stores.push(store);
  const account = store.createAccount({ email: "promote@example.com" });
  const db = new Database(path);
  db.prepare(`
    UPDATE backup_accounts
    SET lifecycle_status = 'registered', revision = 7,
        access_token = ?, refresh_token = ?
    WHERE id = ?
  `).run(
    cipher.encrypt("access-token"),
    options.refreshToken === undefined
      ? cipher.encrypt("refresh-token")
      : options.refreshToken === null ? null : cipher.encrypt(options.refreshToken),
    account.id,
  );
  db.close();
  return { store, accountId: account.id, path, cipher };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("account-factory promotion store", () => {
  it("durably plans a refreshable promotion and replays the explicit idempotency key", () => {
    const { store, accountId } = registeredAccount();
    const input = {
      schemaVersion: 1 as const,
      idempotencyKey: "promotion-1",
      expectedRevision: 7,
      allowEphemeral: false,
    };

    const first = store.planPromotion(accountId, input);
    const replay = store.planPromotion(accountId, { ...input, expectedRevision: 0 });

    expect(first).toMatchObject({
      promotion: { accountId, idempotencyKey: "promotion-1", mode: "refreshable", state: "planned" },
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    expect(replay).toEqual(first);
    expect(store.getPromotion(accountId)).toEqual(first.promotion);
  });

  it("rejects AT-only promotion unless ephemeral mode is explicit", () => {
    const { store, accountId } = registeredAccount({ refreshToken: null });
    const base = {
      schemaVersion: 1 as const,
      idempotencyKey: "promotion-at",
      expectedRevision: 7,
    };

    expect(() => store.planPromotion(accountId, { ...base, allowEphemeral: false }))
      .toThrow("refresh_token_required");
    expect(store.getPromotion(accountId)).toBeNull();

    expect(store.planPromotion(accountId, { ...base, allowEphemeral: true })).toMatchObject({
      promotion: { mode: "ephemeral", state: "planned" },
      accessToken: "access-token",
      refreshToken: null,
    });
  });

  it("rejects revision drift and idempotency-key reuse across accounts", () => {
    const first = registeredAccount();
    expect(() => first.store.planPromotion(first.accountId, {
      schemaVersion: 1,
      idempotencyKey: "revision-conflict",
      expectedRevision: 6,
      allowEphemeral: false,
    })).toThrow("Account factory source revision conflict");

    first.store.planPromotion(first.accountId, {
      schemaVersion: 1,
      idempotencyKey: "shared-key",
      expectedRevision: 7,
      allowEphemeral: false,
    });
    const secondAccount = first.store.createAccount({ email: "other@example.com" });
    const db = new Database(first.path);
    db.prepare(`
      UPDATE backup_accounts SET lifecycle_status = 'registered', revision = 0,
        access_token = ?, refresh_token = ? WHERE id = ?
    `).run(first.cipher.encrypt("other-at"), first.cipher.encrypt("other-rt"), secondAccount.id);
    db.close();

    expect(() => first.store.planPromotion(secondAccount.id, {
      schemaVersion: 1,
      idempotencyKey: "shared-key",
      expectedRevision: 0,
      allowEphemeral: false,
    })).toThrow("idempotency_conflict");
  });
});
