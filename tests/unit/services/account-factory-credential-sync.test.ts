import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
