import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountFactoryPromotionService,
  type AccountFactoryPromotionImporter,
} from "@src/backup-resources/promotion.js";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";

const tempDirs: string[] = [];
const stores: BackupResourceStore[] = [];

function fixture(refreshToken: string | null = "refresh-token") {
  const dir = mkdtempSync(join(tmpdir(), "account-factory-promotion-service-"));
  tempDirs.push(dir);
  const path = join(dir, "backup-resources.sqlite");
  const cipher = createTestCipher();
  const store = new BackupResourceStore(path, cipher);
  stores.push(store);
  const account = store.createAccount({ email: "shared@example.com" });
  const db = new Database(path);
  db.prepare(`
    UPDATE backup_accounts SET lifecycle_status = 'registered', revision = 4,
      access_token = ?, refresh_token = ? WHERE id = ?
  `).run(
    cipher.encrypt("workspace-derived-access-token"),
    refreshToken === null ? null : cipher.encrypt(refreshToken),
    account.id,
  );
  db.close();
  return { store, path, accountId: account.id };
}

function input(allowEphemeral = false) {
  return {
    schemaVersion: 1 as const,
    idempotencyKey: "promotion-operation",
    expectedRevision: 4,
    allowEphemeral,
  };
}

function successfulImporter(entryId = "core-workspace-account") {
  return {
    importPromotion: vi.fn(async () => ({
      ok: true as const,
      entryId,
      account: {} as never,
    })),
  } satisfies AccountFactoryPromotionImporter;
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("AccountFactoryPromotionService", () => {
  it("imports with token-derived credentials and links a refreshable account", async () => {
    const { store, path, accountId } = fixture();
    const importer = successfulImporter();

    const result = await new AccountFactoryPromotionService(store, importer).promote(accountId, input());

    expect(importer.importPromotion).toHaveBeenCalledWith({
      accessToken: "workspace-derived-access-token",
      refreshToken: "refresh-token",
      mode: "refreshable",
    });
    expect(result).toMatchObject({ state: "linked", coreAccountId: "core-workspace-account" });
    const db = new Database(path);
    expect(db.prepare(`
      SELECT lifecycle_status, active_account_id, promotion_mode
      FROM backup_accounts WHERE id = ?
    `).get(accountId)).toEqual({
      lifecycle_status: "promoted",
      active_account_id: "core-workspace-account",
      promotion_mode: "refreshable",
    });
    db.close();
  });

  it("persists failed import without promoting the aggregate and permits retry", async () => {
    const { store, path, accountId } = fixture();
    const importer: AccountFactoryPromotionImporter = {
      importPromotion: vi.fn()
        .mockRejectedValueOnce(new Error("network token must not leak"))
        .mockResolvedValueOnce({ ok: true, entryId: "core-after-retry", account: {} as never }),
    };
    const service = new AccountFactoryPromotionService(store, importer);

    await expect(service.promote(accountId, input())).rejects.toThrow("core_import_failed");
    expect(store.getPromotion(accountId)).toMatchObject({ state: "failed", errorCode: "core_import_failed" });
    const db = new Database(path);
    expect(db.prepare("SELECT lifecycle_status, active_account_id FROM backup_accounts WHERE id = ?").get(accountId))
      .toEqual({ lifecycle_status: "registered", active_account_id: null });
    db.close();

    await expect(service.promote(accountId, input())).resolves.toMatchObject({
      state: "linked",
      coreAccountId: "core-after-retry",
    });
  });

  it("replays the same token identity after import returns before imported persistence", async () => {
    const { store, accountId } = fixture();
    const importer = successfulImporter("same-token-derived-core-id");
    const originalMarkImported = store.markPromotionImported.bind(store);
    store.markPromotionImported = vi.fn(() => {
      throw new Error("simulated crash before imported persistence");
    });
    const service = new AccountFactoryPromotionService(store, importer);

    await expect(service.promote(accountId, input())).rejects.toThrow("simulated crash");
    expect(store.getPromotion(accountId)).toMatchObject({ state: "importing", coreAccountId: null });

    store.markPromotionImported = originalMarkImported;
    await expect(service.promote(accountId, input())).resolves.toMatchObject({
      state: "linked",
      coreAccountId: "same-token-derived-core-id",
    });
    expect(importer.importPromotion).toHaveBeenCalledTimes(2);
    expect(importer.importPromotion.mock.calls[0]).toEqual(importer.importPromotion.mock.calls[1]);
  });

  it("resumes an imported saga at link without invoking core import again", async () => {
    const { store, path, accountId } = fixture();
    const importer = successfulImporter("durable-imported-core-id");
    const originalLink = store.linkPromotion.bind(store);
    store.linkPromotion = vi.fn(() => {
      throw new Error("simulated crash before aggregate link");
    });
    const service = new AccountFactoryPromotionService(store, importer);

    await expect(service.promote(accountId, input())).rejects.toThrow("simulated crash");
    expect(store.getPromotion(accountId)).toMatchObject({
      state: "imported",
      coreAccountId: "durable-imported-core-id",
    });
    const db = new Database(path);
    expect(db.prepare("SELECT lifecycle_status, active_account_id FROM backup_accounts WHERE id = ?").get(accountId))
      .toEqual({ lifecycle_status: "registered", active_account_id: null });
    db.close();

    store.linkPromotion = originalLink;
    await expect(service.promote(accountId, input())).resolves.toMatchObject({
      state: "linked",
      coreAccountId: "durable-imported-core-id",
    });
    expect(importer.importPromotion).toHaveBeenCalledTimes(1);
  });

  it("rejects AT-only by default before invoking the importer", async () => {
    const { store, accountId } = fixture(null);
    const importer = successfulImporter();
    const service = new AccountFactoryPromotionService(store, importer);

    await expect(service.promote(accountId, input())).rejects.toThrow("refresh_token_required");
    expect(importer.importPromotion).not.toHaveBeenCalled();

    await expect(service.promote(accountId, input(true))).resolves.toMatchObject({ mode: "ephemeral", state: "linked" });
    expect(importer.importPromotion).toHaveBeenCalledWith({
      accessToken: "workspace-derived-access-token",
      refreshToken: null,
      mode: "ephemeral",
    });
  });

  it("repairs a linked promotion when its core entry was deleted", async () => {
    const { store, accountId } = fixture();
    const importer = {
      importPromotion: vi.fn()
        .mockResolvedValueOnce({ ok: true as const, entryId: "core-before-delete", account: {} as never })
        .mockResolvedValueOnce({ ok: true as const, entryId: "core-after-repair", account: {} as never }),
    };
    const service = new AccountFactoryPromotionService(store, importer, {
      coreAccountExists: () => false,
    });

    const first = await service.promote(accountId, input());
    expect(first).toMatchObject({ state: "linked", coreAccountId: "core-before-delete" });

    const repaired = await service.promote(accountId, {
      ...input(),
      expectedRevision: 5,
    });

    expect(repaired).toMatchObject({ state: "linked", coreAccountId: "core-after-repair" });
    expect(importer.importPromotion).toHaveBeenCalledTimes(2);
    expect(store.getPromotion(accountId)).toMatchObject({
      state: "linked",
      coreAccountId: "core-after-repair",
      idempotencyKey: "promotion-operation",
    });
  });
});
