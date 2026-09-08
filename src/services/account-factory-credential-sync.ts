import type { BackupResourceStore } from "../backup-resources/store.js";
import type { AccountFactoryPromotionService } from "../backup-resources/promotion.js";
import type { AccountStatus } from "../auth/types.js";

const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  "active",
  "expired",
  "quota_exhausted",
  "refreshing",
  "disabled",
  "banned",
];

export interface AccountFactoryCredentialSyncInput {
  email: string;
  accessToken: string;
  refreshToken?: string | null;
  session?: string | Record<string, unknown> | null;
  /** Explicitly run the post-sync promotion step when the caller needs a core entry. */
  promote?: boolean;
}

export interface AccountFactoryCredentialSyncResult {
  email: string;
  coreAccountId: string | null;
  coreAccountStatus?: string | null;
  backupAccountIds: string[];
}

export interface AccountFactoryCoreAccountStore {
  getEntry(id: string): unknown;
  updateTokenByEmail(email: string, accessToken: string, refreshToken?: string): string | null;
  updateToken(id: string, accessToken: string, refreshToken?: string): void;
}

export async function syncAccountFactoryCredentials(
  store: BackupResourceStore,
  coreAccounts: AccountFactoryCoreAccountStore,
  promotionService: AccountFactoryPromotionService,
  input: AccountFactoryCredentialSyncInput,
): Promise<AccountFactoryCredentialSyncResult> {
  const email = input.email.trim().toLowerCase();
  const session = input.session === undefined
    ? undefined
    : (typeof input.session === "string" ? input.session : JSON.stringify(input.session));
  const backupAccounts = store.listAccounts().filter(
    (account) => account.email.trim().toLowerCase() === email,
  );
  const syncedAccounts = backupAccounts.map((account) => (
    store.syncRegisteredCredentials(account.id, {
      accessToken: input.accessToken,
      ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
      ...(session !== undefined ? { session } : {}),
    })
  )).filter((account): account is NonNullable<typeof account> => account !== null);

  const promotions = syncedAccounts.map((account) => ({
    account,
    promotion: store.getPromotion(account.id),
  }));
  const linkedCoreIds = promotions
    .map(({ promotion }) => promotion?.coreAccountId ?? null)
    .filter((id): id is string => Boolean(id));
  const linkedCoreId = linkedCoreIds.length === 1 ? linkedCoreIds[0] : null;
  let coreAccountId = linkedCoreId && coreAccounts.getEntry(linkedCoreId)
    ? linkedCoreId
    : coreAccounts.updateTokenByEmail(email, input.accessToken, input.refreshToken ?? undefined);
  if (linkedCoreId && coreAccountId) {
    coreAccounts.updateToken(coreAccountId, input.accessToken, input.refreshToken ?? undefined);
  }

  const missingLinkedCore = promotions.some(({ promotion }) => (
    promotion?.state === "linked"
    && (!promotion.coreAccountId || !coreAccounts.getEntry(promotion.coreAccountId))
  ));
  const requestedPromotion = input.promote === true
    || Boolean(input.refreshToken?.trim())
    || (missingLinkedCore && syncedAccounts.some((account) => account.hasRefreshToken));

  if (!coreAccountId && requestedPromotion && syncedAccounts.length > 0) {
    const account = syncedAccounts[0];
    const existingPromotion = store.getPromotion(account.id);
    const promotion = await promotionService.promote(account.id, {
      schemaVersion: 1,
      idempotencyKey: existingPromotion?.idempotencyKey ?? `credential-sync:${account.id}`,
      expectedRevision: account.revision,
      allowEphemeral: false,
    });
    coreAccountId = promotion.coreAccountId;
  }

  if (!coreAccountId && syncedAccounts.length === 0) {
    throw new Error("credential_sync_account_not_found");
  }
  const coreEntry = coreAccountId ? coreAccounts.getEntry(coreAccountId) : undefined;
  const coreAccountStatus = coreEntry && typeof coreEntry === "object" && "status" in coreEntry
    && isAccountStatus(coreEntry.status)
    ? coreEntry.status
    : null;
  return {
    email,
    coreAccountId,
    coreAccountStatus,
    backupAccountIds: syncedAccounts.map((account) => account.id),
  };
}

function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === "string" && ACCOUNT_STATUSES.includes(value as AccountStatus);
}
