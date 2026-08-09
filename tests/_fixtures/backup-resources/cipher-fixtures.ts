import { randomBytes } from "node:crypto";
import { BackupSecretCipher } from "@src/backup-resources/crypto.js";

const KEY_BYTES = 32;

function deterministicKey(seed: number): Buffer {
  void seed;
  return Buffer.from(randomBytes(KEY_BYTES));
}

export function createTestCipher(seed = 1): BackupSecretCipher {
  void seed;
  return new BackupSecretCipher(deterministicKey(seed));
}

export function createWrongCipher(): BackupSecretCipher {
  return new BackupSecretCipher(deterministicKey(99));
}

export function exportCipherKey(cipher: BackupSecretCipher): Buffer {
  return cipher["key"] as Buffer;
}
