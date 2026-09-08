import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { AccountFactoryPromotionService } from "@src/backup-resources/promotion.js";
import { syncAccountFactoryCredentials } from "@src/services/account-factory-credential-sync.js";
import { createTestCipher } from "@fixtures/backup-resources/cipher-fixtures.js";

const stores: BackupResourceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("account factory registered credential sync", () => {
  it("revives a dashboard account and promotes refreshed credentials into the core pool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "account-factory-credential-sync-"));
    tempDirs.push(dir);
    const store = new BackupResourceStore(
      join(dir, "backup-resources.sqlite"),
      createTestCipher(),
    );
    stores.push(store);
    const account = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mailbox-1",
      email: "Registered@Example.com",
      sourceRevision: "mail-revision-1",
    });
    const imported: unknown[] = [];
    const promotionService = new AccountFactoryPromotionService(store, {
      importPromotion: async (input) => {
        imported.push(input);
        return { ok: true as const, entryId: "core-1", accountId: "upstream-1", email: "registered@example.com" };
      },
    });
    const coreAccounts = {
      getEntry: () => undefined,
      updateTokenByEmail: () => null,
      updateToken: () => undefined,
    };

    const result = await syncAccountFactoryCredentials(
      store,
      coreAccounts,
      promotionService,
      {
        email: "registered@example.com",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        session: { sessionToken: "session-token" },
      },
    );

    expect(result).toEqual({
      email: "registered@example.com",
      coreAccountId: "core-1",
      coreAccountStatus: null,
      backupAccountIds: [account.id],
    });
    expect(imported).toEqual([{
      accessToken: "access-token",
      refreshToken: "refresh-token",
      mode: "refreshable",
    }]);
    expect(store.listAccounts().find((item) => item.id === account.id)).toMatchObject({
      accountStatus: "free",
      lifecycleStatus: "promoted",
      hasAccessToken: true,
      hasRefreshToken: true,
      hasSession: true,
    });
  });

  it("uses the stored refresh token to repair a deleted core entry after relogin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "account-factory-credential-repair-"));
    tempDirs.push(dir);
    const store = new BackupResourceStore(
      join(dir, "backup-resources.sqlite"),
      createTestCipher(),
    );
    stores.push(store);
    const source = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mailbox-repair",
      email: "Repair@Example.com",
      sourceRevision: "mail-revision-1",
    });
    const registered = store.syncRegisteredCredentials(source.id, {
      accessToken: "old-access-token",
      refreshToken: "stored-refresh-token",
    });
    expect(registered).not.toBeNull();

    const imported = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, entryId: "core-deleted", account: {} as never })
      .mockResolvedValueOnce({ ok: true as const, entryId: "core-repaired", account: {} as never });
    const promotionService = new AccountFactoryPromotionService(store, {
      importPromotion: imported,
    }, {
      coreAccountExists: () => false,
    });
    const coreAccounts = {
      getEntry: () => undefined,
      updateTokenByEmail: () => null,
      updateToken: () => undefined,
    };

    const first = await promotionService.promote(source.id, {
      schemaVersion: 1,
      idempotencyKey: "repair-promotion",
      expectedRevision: registered!.revision,
      allowEphemeral: false,
    });
    expect(first.coreAccountId).toBe("core-deleted");

    const result = await syncAccountFactoryCredentials(
      store,
      coreAccounts,
      promotionService,
      {
        email: "repair@example.com",
        accessToken: "new-access-token",
        session: "new-session",
        promote: true,
      },
    );

    expect(result).toMatchObject({
      email: "repair@example.com",
      coreAccountId: "core-repaired",
      backupAccountIds: [source.id],
    });
    expect(imported).toHaveBeenCalledTimes(2);
    expect(imported.mock.calls[1][0]).toMatchObject({
      accessToken: "new-access-token",
      refreshToken: "stored-refresh-token",
      mode: "refreshable",
    });
    expect(store.listAccounts().find((item) => item.id === source.id)).toMatchObject({
      lifecycleStatus: "promoted",
      hasRefreshToken: true,
    });
  });

  it.each([
    ["active", "active"],
    ["disabled", "disabled"],
    ["banned", "banned"],
    ["missing", null],
  ] as const)("reports the current core account status for %s without changing it", async (_label, status) => {
    const dir = mkdtempSync(join(tmpdir(), "account-factory-credential-status-"));
    tempDirs.push(dir);
    const store = new BackupResourceStore(
      join(dir, "backup-resources.sqlite"),
      createTestCipher(),
    );
    stores.push(store);
    const account = store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: `mailbox-status-${_label}`,
      email: "Status@Example.com",
      sourceRevision: "mail-revision-1",
    });
    store.syncRegisteredCredentials(account.id, { accessToken: "access-token" });
    const coreEntry = status === null ? undefined : { status };
    const coreAccounts = {
      getEntry: () => coreEntry,
      updateTokenByEmail: () => "core-status",
      updateToken: () => undefined,
    };

    const result = await syncAccountFactoryCredentials(
      store,
      coreAccounts,
      {} as AccountFactoryPromotionService,
      { email: "status@example.com", accessToken: "new-access-token" },
    );

    expect(result).toMatchObject({
      coreAccountId: "core-status",
      coreAccountStatus: status,
    });
    expect(coreEntry?.status ?? null).toBe(status);
  });
});
