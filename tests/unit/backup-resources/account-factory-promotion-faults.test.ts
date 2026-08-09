import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountFactoryPromotionService,
  accountImportPromotionImporter,
  type AccountFactoryPromotionImportInput,
  type AccountFactoryPromotionImporter,
} from "@src/backup-resources/promotion.js";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { AccountImportService } from "@src/services/account-import.js";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";

const tempDirs: string[] = [];
const stores = new Set<BackupResourceStore>();
const pools = new Set<AccountPool>();

interface PromotionFixture {
  store: BackupResourceStore;
  path: string;
  cipher: ReturnType<typeof createTestCipher>;
  accountId: string;
}

function fixture(options: {
  workspaceId: string;
  userId?: string;
  email?: string;
  refreshToken?: string | null;
}): PromotionFixture {
  const dir = mkdtempSync(join(tmpdir(), "account-factory-promotion-faults-"));
  tempDirs.push(dir);
  const path = join(dir, "backup-resources.sqlite");
  const cipher = createTestCipher();
  const store = new BackupResourceStore(path, cipher);
  stores.add(store);
  const email = options.email ?? "shared@example.com";
  const account = store.createAccount({ email });
  const token = createValidJwt({
    accountId: options.workspaceId,
    userId: options.userId ?? "same-user",
    email,
  });
  const db = new Database(path);
  db.prepare(`
    UPDATE backup_accounts
    SET lifecycle_status = 'registered', revision = 4,
        access_token = ?, refresh_token = ?
    WHERE id = ?
  `).run(
    cipher.encrypt(token),
    options.refreshToken === null
      ? null
      : cipher.encrypt(options.refreshToken ?? `rt-${options.workspaceId}`),
    account.id,
  );
  db.close();
  return { store, path, cipher, accountId: account.id };
}

function restart(current: PromotionFixture): BackupResourceStore {
  current.store.close();
  stores.delete(current.store);
  const reopened = new BackupResourceStore(current.path, current.cipher);
  stores.add(reopened);
  current.store = reopened;
  return reopened;
}

function promotionInput(idempotencyKey: string, allowEphemeral = false) {
  return {
    schemaVersion: 1 as const,
    idempotencyKey,
    expectedRevision: 4,
    allowEphemeral,
  };
}

function coreHarness() {
  const pool = new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 300,
  });
  pools.add(pool);
  const scheduler = { scheduleOne: vi.fn<(id: string, token: string) => void>() };
  const importService = new AccountImportService(pool, scheduler, {
    validateToken: () => ({ valid: true }),
    refreshToken: async () => { throw new Error("unexpected refresh exchange"); },
    getProxyUrl: () => null,
  });
  const adapter = accountImportPromotionImporter(importService);
  const importPromotion = vi.fn((input: AccountFactoryPromotionImportInput) =>
    adapter.importPromotion(input));
  return {
    pool,
    scheduler,
    importer: { importPromotion } satisfies AccountFactoryPromotionImporter,
    importPromotion,
  };
}

function aggregate(path: string, accountId: string) {
  const db = new Database(path, { readonly: true });
  const row = db.prepare(`
    SELECT lifecycle_status, active_account_id, promotion_mode
    FROM backup_accounts WHERE id = ?
  `).get(accountId);
  db.close();
  return row;
}

afterEach(() => {
  for (const pool of pools) pool.destroy();
  pools.clear();
  for (const store of stores) store.close();
  stores.clear();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("account-factory promotion fault injection", () => {
  it("deduplicates duplicate RT requests but never merges same-email different-workspace identities", async () => {
    const core = coreHarness();
    const refreshable = fixture({ workspaceId: "workspace-refreshable" });
    const refreshableService = new AccountFactoryPromotionService(refreshable.store, core.importer);

    const [first, replay] = await Promise.all([
      refreshableService.promote(refreshable.accountId, promotionInput("duplicate-rt")),
      refreshableService.promote(refreshable.accountId, promotionInput("duplicate-rt")),
    ]);

    expect(first.coreAccountId).toBe(replay.coreAccountId);
    expect(core.pool.getAllEntries()).toHaveLength(1);
    expect(core.pool.getAllEntries()[0]).toMatchObject({
      accountId: "workspace-refreshable",
      email: "shared@example.com",
      refreshToken: "rt-workspace-refreshable",
    });

    const ephemeral = fixture({
      workspaceId: "workspace-ephemeral",
      email: "shared@example.com",
      refreshToken: null,
    });
    const ephemeralService = new AccountFactoryPromotionService(ephemeral.store, core.importer);
    await expect(ephemeralService.promote(ephemeral.accountId, promotionInput("at-default")))
      .rejects.toThrow("refresh_token_required");
    expect(aggregate(ephemeral.path, ephemeral.accountId)).toEqual({
      lifecycle_status: "registered",
      active_account_id: null,
      promotion_mode: null,
    });
    const ephemeralResult = await ephemeralService.promote(
      ephemeral.accountId,
      promotionInput("at-ephemeral", true),
    );

    expect(core.pool.getAllEntries()).toHaveLength(2);
    expect(core.pool.getAllEntries().map((entry) => entry.accountId).sort()).toEqual([
      "workspace-ephemeral",
      "workspace-refreshable",
    ]);
    expect(core.pool.getAllEntries().filter((entry) => entry.email === "shared@example.com"))
      .toHaveLength(2);
    expect(core.pool.getAllEntries().find((entry) => entry.id === ephemeralResult.coreAccountId))
      .toMatchObject({ accountId: "workspace-ephemeral", refreshToken: null });
    expect(aggregate(refreshable.path, refreshable.accountId)).toEqual({
      lifecycle_status: "promoted",
      active_account_id: first.coreAccountId,
      promotion_mode: "refreshable",
    });
    expect(aggregate(ephemeral.path, ephemeral.accountId)).toEqual({
      lifecycle_status: "promoted",
      active_account_id: ephemeralResult.coreAccountId,
      promotion_mode: "ephemeral",
    });
  });

  it("replays token identity after import returns before imported persistence without duplicating core", async () => {
    const core = coreHarness();
    const backup = fixture({ workspaceId: "workspace-after-import" });
    backup.store.markPromotionImported = vi.fn(() => {
      throw new Error("simulated crash before imported persistence");
    });

    await expect(new AccountFactoryPromotionService(backup.store, core.importer)
      .promote(backup.accountId, promotionInput("after-import")))
      .rejects.toThrow("simulated crash before imported persistence");
    expect(backup.store.getPromotion(backup.accountId)).toMatchObject({
      state: "importing",
      coreAccountId: null,
    });
    expect(core.pool.getAllEntries()).toHaveLength(1);
    expect(aggregate(backup.path, backup.accountId)).toMatchObject({
      lifecycle_status: "registered",
      active_account_id: null,
    });

    const reopened = restart(backup);
    const result = await new AccountFactoryPromotionService(reopened, core.importer)
      .promote(backup.accountId, promotionInput("after-import"));

    expect(result).toMatchObject({ state: "linked" });
    expect(core.importPromotion).toHaveBeenCalledTimes(2);
    expect(core.importPromotion.mock.calls[0]).toEqual(core.importPromotion.mock.calls[1]);
    expect(core.pool.getAllEntries()).toHaveLength(1);
    expect(result.coreAccountId).toBe(core.pool.getAllEntries()[0].id);
  });

  it("resumes an imported restart at link without reimporting and promotes only after link", async () => {
    const core = coreHarness();
    const backup = fixture({ workspaceId: "workspace-before-link" });
    backup.store.linkPromotion = vi.fn(() => {
      throw new Error("simulated crash before aggregate link");
    });

    await expect(new AccountFactoryPromotionService(backup.store, core.importer)
      .promote(backup.accountId, promotionInput("before-link")))
      .rejects.toThrow("simulated crash before aggregate link");
    const imported = backup.store.getPromotion(backup.accountId);
    expect(imported).toMatchObject({ state: "imported" });
    expect(aggregate(backup.path, backup.accountId)).toEqual({
      lifecycle_status: "registered",
      active_account_id: null,
      promotion_mode: null,
    });

    const reopened = restart(backup);
    const linked = await new AccountFactoryPromotionService(reopened, core.importer)
      .promote(backup.accountId, promotionInput("before-link"));

    expect(core.importPromotion).toHaveBeenCalledTimes(1);
    expect(linked).toMatchObject({ state: "linked", coreAccountId: imported?.coreAccountId });
    expect(aggregate(backup.path, backup.accountId)).toEqual({
      lifecycle_status: "promoted",
      active_account_id: linked.coreAccountId,
      promotion_mode: "refreshable",
    });
  });
});
