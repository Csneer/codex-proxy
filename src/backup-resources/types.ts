export const BACKUP_ACCOUNT_STATUSES = ["plus", "free", "unregistered", "pro"] as const;
export type BackupAccountStatus = typeof BACKUP_ACCOUNT_STATUSES[number];

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
