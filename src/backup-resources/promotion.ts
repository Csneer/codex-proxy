import type { AccountImportService, ImportOneResult } from "../services/account-import.js";
import {
  AccountFactoryPromotionError,
  type BackupResourceStore,
} from "./store.js";
import type {
  AccountFactoryPromoteDto,
  AccountFactoryPromotion,
  AccountFactoryPromotionMode,
} from "./types.js";

export interface AccountFactoryPromotionImportInput {
  accessToken: string;
  refreshToken: string | null;
  mode: AccountFactoryPromotionMode;
}

export interface AccountFactoryPromotionImporter {
  importPromotion(input: AccountFactoryPromotionImportInput): Promise<ImportOneResult>;
}

export interface AccountFactoryPromotionServiceOptions {
  /** Return whether a persisted core entry is currently present in the pool. */
  coreAccountExists?: (coreAccountId: string) => boolean;
}

/** Narrow adapter: identity is derived exclusively by AccountImportService from tokens. */
export function accountImportPromotionImporter(
  importService: Pick<AccountImportService, "importOne">,
): AccountFactoryPromotionImporter {
  return {
    importPromotion: ({ accessToken, refreshToken, mode }) =>
      importService.importOne(
        accessToken,
        refreshToken ?? undefined,
        mode === "ephemeral" ? { refreshTokenPolicy: "clear" } : undefined,
      ),
  };
}

export class AccountFactoryPromotionService {
  private readonly coreAccountExists: (coreAccountId: string) => boolean;

  constructor(
    private readonly store: BackupResourceStore,
    private readonly importer: AccountFactoryPromotionImporter,
    options: AccountFactoryPromotionServiceOptions = {},
  ) {
    // Older embedders do not expose the core pool. Preserve the original
    // idempotent linked short-circuit for those callers; the running server
    // supplies the real presence check so a stale link can be repaired.
    this.coreAccountExists = options.coreAccountExists ?? (() => true);
  }

  async promote(accountId: string, input: AccountFactoryPromoteDto): Promise<AccountFactoryPromotion> {
    let operationInput = input;
    let plan = this.store.planPromotion(accountId, operationInput);
    if (plan.promotion.state === "linked") {
      const corePresent = plan.promotion.coreAccountId
        ? this.safeCoreAccountExists(plan.promotion.coreAccountId)
        : false;
      if (corePresent) return plan.promotion;

      // Keep the original idempotency identity while reopening the saga. This
      // lets a retry repair a stale linked row without creating a second
      // promotion record for the same backup account.
      operationInput = {
        ...operationInput,
        idempotencyKey: plan.promotion.idempotencyKey,
      };
      plan = this.store.repairLinkedPromotion(accountId, operationInput);
    }
    if (plan.promotion.state === "imported") {
      return this.store.linkPromotion(accountId, operationInput.idempotencyKey);
    }

    const importing = this.store.markPromotionImporting(accountId, operationInput.idempotencyKey);
    if (importing.state === "linked") return importing;
    if (importing.state === "imported") {
      return this.store.linkPromotion(accountId, operationInput.idempotencyKey);
    }

    let imported: ImportOneResult;
    try {
      imported = await this.importer.importPromotion({
        accessToken: plan.accessToken,
        refreshToken: plan.refreshToken,
        mode: plan.promotion.mode,
      });
    } catch {
      this.store.failPromotion(accountId, operationInput.idempotencyKey, "core_import_failed");
      throw new AccountFactoryPromotionError("core_import_failed");
    }
    if (!imported.ok) {
      const code = imported.kind === "refresh_failed"
        ? "core_refresh_failed"
        : "core_import_invalid";
      this.store.failPromotion(accountId, operationInput.idempotencyKey, code);
      throw new AccountFactoryPromotionError(code);
    }

    // Persist the token-derived core entry id before touching the aggregate.
    // A crash here leaves `importing`; replay calls the same token import again.
    this.store.markPromotionImported(accountId, operationInput.idempotencyKey, imported.entryId);

    // Linking is a separate atomic store transaction. If it fails, `imported`
    // survives and the next request skips core import entirely.
    return this.store.linkPromotion(accountId, operationInput.idempotencyKey);
  }

  private safeCoreAccountExists(coreAccountId: string): boolean {
    try {
      return this.coreAccountExists(coreAccountId);
    } catch {
      // A transient pool lookup failure must not make a healthy linked record
      // look repaired; treating it as absent is safe because import is
      // identity-deduplicated by AccountPool.
      return false;
    }
  }
}
