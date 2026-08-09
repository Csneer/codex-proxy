import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDataDir } from "../paths.js";
import { BackupSecretCipher, loadBackupEncryptionKey } from "./crypto.js";
import { BackupResourceStore } from "./store.js";
import type {
  AccountFactoryClaimInput,
  AccountFactoryClaimResult,
  AccountFactoryAccountSyncState,
  AccountFactoryCompleteInput,
  AccountFactoryFailInput,
  AccountFactoryLease,
  AccountFactoryOperationInput,
  AccountFactoryProgressInput,
  AccountFactorySourceReconcileInput,
  AccountFactorySourceReconcileResult,
  AccountFactorySourceSystem,
  AccountFactorySyncInput,
  AccountFactorySyncState,
} from "./types.js";

export class AccountFactoryLifecycleService {
  constructor(private readonly store: BackupResourceStore) {}

  sync(input: AccountFactorySyncInput) {
    return this.store.syncSourceAccount(input);
  }

  reconcileSourceAccounts(input: AccountFactorySourceReconcileInput): AccountFactorySourceReconcileResult {
    return this.store.reconcileSourceAccounts(input);
  }

  claim(input: AccountFactoryClaimInput): AccountFactoryClaimResult | null {
    return this.store.claimAccount(input);
  }

  getLease(taskId: string): AccountFactoryLease | null {
    return this.store.getLease(taskId);
  }

  commitSubmission(input: AccountFactoryOperationInput): AccountFactoryLease {
    return this.store.commitSubmission(input);
  }

  reportProgress(input: AccountFactoryProgressInput): AccountFactoryLease {
    return this.store.reportProgress(input);
  }

  complete(input: AccountFactoryCompleteInput): AccountFactoryAccountSyncState {
    return this.store.completeLease(input);
  }

  fail(input: AccountFactoryFailInput): AccountFactoryLease {
    return this.store.failLease(input);
  }

  getSyncState(sourceSystem: AccountFactorySourceSystem): AccountFactorySyncState {
    return this.store.getSyncState(sourceSystem);
  }

  getAccountSyncState(accountId: string): AccountFactoryAccountSyncState | null {
    return this.store.getAccountSyncState(accountId);
  }
}

let accountFactoryLifecycleService: AccountFactoryLifecycleService | null = null;

export function getAccountFactoryLifecycleService(): AccountFactoryLifecycleService {
  if (accountFactoryLifecycleService) return accountFactoryLifecycleService;
  accountFactoryLifecycleService = new AccountFactoryLifecycleService(getBackupResourceStore());
  return accountFactoryLifecycleService;
}

export function resetAccountFactoryLifecycleServiceForTest(): void {
  accountFactoryLifecycleService = null;
}


let store: BackupResourceStore | null = null;

export function getBackupResourceStore(): BackupResourceStore {
  if (store) return store;
  const dataDir = getDataDir();
  const databasePath = resolve(dataDir, "backup-resources.sqlite");
  const key = loadBackupEncryptionKey(
    resolve(dataDir, "backup-resources.key"),
    { allowCreate: !existsSync(databasePath) },
  );
  store = new BackupResourceStore(
    databasePath,
    new BackupSecretCipher(key),
  );
  return store;
}

export function closeBackupResourceService(): void {
  store?.close();
  store = null;
  resetAccountFactoryLifecycleServiceForTest();
}

export const resetBackupResourceStoreForTest = closeBackupResourceService;
