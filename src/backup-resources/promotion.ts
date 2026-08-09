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
  constructor(
    private readonly store: BackupResourceStore,
    private readonly importer: AccountFactoryPromotionImporter,
  ) {}

  async promote(accountId: string, input: AccountFactoryPromoteDto): Promise<AccountFactoryPromotion> {
    const plan = this.store.planPromotion(accountId, input);
    if (plan.promotion.state === "linked") return plan.promotion;
    if (plan.promotion.state === "imported") {
      return this.store.linkPromotion(accountId, input.idempotencyKey);
    }

    const importing = this.store.markPromotionImporting(accountId, input.idempotencyKey);
    if (importing.state === "linked") return importing;
    if (importing.state === "imported") {
      return this.store.linkPromotion(accountId, input.idempotencyKey);
    }

    let imported: ImportOneResult;
    try {
      imported = await this.importer.importPromotion({
        accessToken: plan.accessToken,
        refreshToken: plan.refreshToken,
        mode: plan.promotion.mode,
      });
    } catch {
      this.store.failPromotion(accountId, input.idempotencyKey, "core_import_failed");
      throw new AccountFactoryPromotionError("core_import_failed");
    }
    if (!imported.ok) {
      const code = imported.kind === "refresh_failed"
        ? "core_refresh_failed"
        : "core_import_invalid";
      this.store.failPromotion(accountId, input.idempotencyKey, code);
      throw new AccountFactoryPromotionError(code);
    }

    // Persist the token-derived core entry id before touching the aggregate.
    // A crash here leaves `importing`; replay calls the same token import again.
    this.store.markPromotionImported(accountId, input.idempotencyKey, imported.entryId);

    // Linking is a separate atomic store transaction. If it fails, `imported`
    // survives and the next request skips core import entirely.
    return this.store.linkPromotion(accountId, input.idempotencyKey);
  }
}
