export const BACKUP_ACCOUNT_STATUSES = ["plus", "free", "unregistered", "pro"] as const;
export type BackupAccountStatus = typeof BACKUP_ACCOUNT_STATUSES[number];

export const BACKUP_ACCOUNT_LIFECYCLE_STATUSES = [
  "available",
  "leased",
  "registering",
  "registered",
  "promoted",
  "invalid",
  "retired",
] as const;
export type BackupAccountLifecycleStatus = typeof BACKUP_ACCOUNT_LIFECYCLE_STATUSES[number];

export const ACCOUNT_FACTORY_SOURCE_SYSTEMS = [
  "mail_dashboard",
  "extension",
  "manual",
] as const;
export type AccountFactorySourceSystem = typeof ACCOUNT_FACTORY_SOURCE_SYSTEMS[number];

export const ACCOUNT_FACTORY_LEASE_STATES = [
  "leased",
  "committed",
  "completed",
  "failed",
  "retired",
] as const;
export type AccountFactoryLeaseState = typeof ACCOUNT_FACTORY_LEASE_STATES[number];

export const ACCOUNT_FACTORY_PROMOTION_MODES = ["refreshable", "ephemeral"] as const;
export type AccountFactoryPromotionMode = typeof ACCOUNT_FACTORY_PROMOTION_MODES[number];

export const ACCOUNT_FACTORY_PROMOTION_STATES = [
  "planned",
  "imported",
  "linked",
  "failed",
] as const;
export type AccountFactoryPromotionState = typeof ACCOUNT_FACTORY_PROMOTION_STATES[number];

export const BACKUP_RESOURCES_SCHEMA_VERSION_KEY = "schema_version";
export const BACKUP_RESOURCES_SCHEMA_VERSION = 2;

export interface BackupAccountInput {
  email: string;
  accountStatus?: BackupAccountStatus;
  emailPassword?: string | null;
  chatgptPassword?: string | null;
  totpSecret?: string | null;
  emailCodeUrl?: string | null;
  note?: string | null;
}

export interface BackupAccountPatch {
  email?: string;
  accountStatus?: BackupAccountStatus;
  emailPassword?: string | null;
  chatgptPassword?: string | null;
  totpSecret?: string | null;
  emailCodeUrl?: string | null;
  note?: string | null;
}

export interface BackupAccountSummary {
  id: string;
  email: string;
  accountStatus: BackupAccountStatus;
  note: string;
  hasEmailPassword: boolean;
  hasChatgptPassword: boolean;
  hasTotpSecret: boolean;
  hasEmailCodeUrl: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackupAccountDetail extends BackupAccountSummary {
  emailPassword: string | null;
  chatgptPassword: string | null;
  totpSecret: string | null;
  emailCodeUrl: string | null;
}

export interface BackupPhoneInput {
  phoneNumber: string;
  useCount?: number;
  note?: string | null;
}

export interface BackupPhonePatch {
  phoneNumber?: string;
  useCount?: number;
  note?: string | null;
}

export interface BackupPhone {
  id: string;
  phoneNumber: string;
  useCount: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreflightConflictRecord {
  id: string;
  email: string;
  emailNormalized: string;
  accountStatus: string;
  lifecycleStatus: string | null;
}

export interface PreflightUndecryptableRecord {
  id: string;
  email: string;
  column: string;
  error: string;
}

export interface PreflightReport {
  schemaVersionCurrent: number;
  schemaVersionTarget: number;
  encryptionKeyOk: boolean;
  totalAccounts: number;
  totalPhones: number;
  conflicts: PreflightConflictRecord[];
  undecryptable: PreflightUndecryptableRecord[];
  readyForMigration: boolean;
  notes: string[];
}

export interface BackupSnapshotResult {
  ok: true;
  source: string;
  destination: string;
  createdAt: string;
  bytes: number;
  integrityCheck: "ok";
}

export interface BackupRestoreResult {
  ok: true;
  source: string;
  destination: string;
  bytes: number;
  integrityCheck: "ok";
}
