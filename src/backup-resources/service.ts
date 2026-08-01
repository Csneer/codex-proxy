import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDataDir } from "../paths.js";
import { BackupSecretCipher, loadBackupEncryptionKey } from "./crypto.js";
import { BackupResourceStore } from "./store.js";

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
}

export const resetBackupResourceStoreForTest = closeBackupResourceService;
