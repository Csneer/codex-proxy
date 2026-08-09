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
export const BACKUP_RESOURCES_SCHEMA_VERSION = 6;

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
  lifecycleStatus: BackupAccountLifecycleStatus;
  sourceSystem: AccountFactorySourceSystem | null;
  sourceActive: boolean;
  revision: number;
  lastMailSyncedAt: string | null;
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

export interface AccountFactorySyncInput {
  sourceSystem: AccountFactorySourceSystem;
  externalId: string;
  email: string;
  sourceRevision: string;
  active?: boolean;
  appleLabel?: string | null;
  operationId?: string;
}

export interface AccountFactorySourceReconcileInput {
  sourceSystem: AccountFactorySourceSystem;
  activeExternalIds: readonly string[];
}

export interface AccountFactorySourceReconcileResult {
  sourceSystem: AccountFactorySourceSystem;
  deactivated: number;
}

export interface AccountFactoryAccount {
  id: string;
  email: string;
  accountStatus: BackupAccountStatus;
  lifecycleStatus: BackupAccountLifecycleStatus;
  sourceSystem: AccountFactorySourceSystem | null;
  externalId: string | null;
  appleLabel: string | null;
  sourceActive: boolean;
  lastMailSyncedAt: string | null;
  revision: number;
  sourceRevision: string | null;
  lastOperationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountFactoryLease {
  id: string;
  accountId: string;
  consumerId: string;
  taskId: string;
  state: AccountFactoryLeaseState;
  submissionCommitted: boolean;
  submissionCommittedAt: string | null;
  claimExpiresAt: string | null;
  failureCode: string | null;
  progress: unknown | null;
  lastOperationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountFactoryClaimInput {
  consumerId: string;
  taskId: string;
  leaseTtlMs?: number;
  operationId?: string;
}

export interface AccountFactoryClaimResult {
  account: AccountFactoryAccount;
  lease: AccountFactoryLease;
  replayed: boolean;
}

export interface AccountFactoryOperationInput {
  leaseId: string;
  taskId: string;
  operationId?: string;
  idempotencyKey?: string;
}

export interface AccountFactoryProgressInput extends AccountFactoryOperationInput {
  progress: unknown;
}

export interface AccountFactoryCompleteInput extends AccountFactoryOperationInput {
  schemaVersion: 1;
  operationId: string;
  idempotencyKey: string;
  sourceRevision: number;
  password?: string;
  chatgptPassword?: string;
  emailPassword?: string | null;
  totpSecret?: string | null;
  session?: unknown | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  accountStatus?: BackupAccountStatus;
  registrationRoute?: string | null;
  eligibilityStatus?: string | null;
  eligibilityReason?: string | null;
  eligibilityCheckedAt?: string | null;
  validityStatus?: string | null;
}

export interface AccountFactoryFailInput extends AccountFactoryOperationInput {
  errorCode: string;
}

/** Explicit Phase 4 promotion DTO. Promotion is never implied by complete. */
export interface AccountFactoryPromoteDto {
  schemaVersion: 1;
  idempotencyKey: string;
  expectedRevision: number;
  allowEphemeral: boolean;
}

export interface AccountFactoryPromotion {
  id: string;
  accountId: string;
  idempotencyKey: string;
  mode: AccountFactoryPromotionMode;
  state: AccountFactoryPromotionState;
  coreAccountId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Internal-only promotion material; route responses must never expose it. */
export interface AccountFactoryPromotionPlan {
  promotion: AccountFactoryPromotion;
  accessToken: string;
  refreshToken: string | null;
}

export interface AccountFactoryAccountSyncState {
  schemaVersion: 1;
  accountId: string;
  lifecycleStatus: BackupAccountLifecycleStatus;
  revision: number;
  lastSourceRevision: number | null;
  lastAppliedOperationId: string | null;
  updatedAt: string;
  hasSession: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}

export interface AccountFactorySyncState {
  sourceSystem: AccountFactorySourceSystem;
  activeAccounts: number;
  availableAccounts: number;
  leasedAccounts: number;
  registeringAccounts: number;
  registeredAccounts: number;
  lastSyncedAt: string | null;
}
