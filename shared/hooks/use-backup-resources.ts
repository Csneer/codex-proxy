import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { adminFetch } from "../http/admin-fetch";

const BASE_URL = "/admin/backup-resources";

export type BackupAccountStatus = "plus" | "free" | "unregistered" | "pro";

export interface BackupAccount {
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

export interface BackupAccountDetail extends BackupAccount {
  emailPassword: string | null;
  chatgptPassword: string | null;
  totpSecret: string | null;
  emailCodeUrl: string | null;
}

export interface BackupAccountInput {
  email: string;
  accountStatus: BackupAccountStatus;
  emailPassword?: string | null;
  chatgptPassword?: string | null;
  totpSecret?: string | null;
  emailCodeUrl?: string | null;
  note?: string;
}

export interface SmsNumber {
  id: string;
  phoneNumber: string;
  useCount: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface SmsNumberInput {
  phoneNumber: string;
  useCount?: number;
  note?: string;
}

async function responseError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string; message?: string };
    return data.error || data.message || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

async function requireOk(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(await responseError(response));
  return response;
}

function listFrom<T>(value: unknown, key: "accounts" | "phones"): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
}

export function useBackupResources() {
  const [accounts, setAccounts] = useState<BackupAccount[]>([]);
  const [phones, setPhones] = useState<SmsNumber[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [phonesLoading, setPhonesLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [phonesError, setPhonesError] = useState<string | null>(null);
  const [detail, setDetail] = useState<BackupAccountDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const response = await requireOk(await adminFetch(`${BASE_URL}/accounts`));
      setAccounts(listFrom<BackupAccount>(await response.json(), "accounts"));
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : String(error));
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  const loadPhones = useCallback(async () => {
    setPhonesLoading(true);
    setPhonesError(null);
    try {
      const response = await requireOk(await adminFetch(`${BASE_URL}/phones`));
      setPhones(listFrom<SmsNumber>(await response.json(), "phones"));
    } catch (error) {
      setPhonesError(error instanceof Error ? error.message : String(error));
    } finally {
      setPhonesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
    void loadPhones();
  }, [loadAccounts, loadPhones]);

  const mutate = useCallback(async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ) => {
    await requireOk(await adminFetch(`${BASE_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }, []);

  const createAccount = useCallback(async (input: BackupAccountInput) => {
    await mutate("/accounts", "POST", input);
    await loadAccounts();
  }, [loadAccounts, mutate]);

  const updateAccount = useCallback(async (id: string, input: Partial<BackupAccountInput>) => {
    await mutate(`/accounts/${encodeURIComponent(id)}`, "PATCH", input);
    await loadAccounts();
    if (detail?.id === id) setDetail(null);
  }, [detail?.id, loadAccounts, mutate]);

  const deleteAccount = useCallback(async (id: string) => {
    await mutate(`/accounts/${encodeURIComponent(id)}`, "DELETE");
    if (detail?.id === id) setDetail(null);
    await loadAccounts();
  }, [detail?.id, loadAccounts, mutate]);

  const loadAccountDetail = useCallback(async (id: string) => {
    const request = ++detailRequest.current;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const response = await requireOk(await adminFetch(`${BASE_URL}/accounts/${encodeURIComponent(id)}`));
      const data = await response.json() as BackupAccountDetail | { account: BackupAccountDetail };
      if (request === detailRequest.current) setDetail("account" in data ? data.account : data);
    } catch (error) {
      if (request === detailRequest.current) setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  const clearAccountDetail = useCallback(() => {
    detailRequest.current += 1;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  const createPhone = useCallback(async (input: SmsNumberInput) => {
    await mutate("/phones", "POST", input);
    await loadPhones();
  }, [loadPhones, mutate]);

  const updatePhone = useCallback(async (id: string, input: Partial<SmsNumberInput>) => {
    await mutate(`/phones/${encodeURIComponent(id)}`, "PATCH", input);
    await loadPhones();
  }, [loadPhones, mutate]);

  const deletePhone = useCallback(async (id: string) => {
    await mutate(`/phones/${encodeURIComponent(id)}`, "DELETE");
    await loadPhones();
  }, [loadPhones, mutate]);

  const usePhoneOnce = useCallback(async (id: string) => {
    await mutate(`/phones/${encodeURIComponent(id)}/use`, "POST");
    await loadPhones();
  }, [loadPhones, mutate]);

  return {
    accounts,
    phones,
    accountsLoading,
    phonesLoading,
    accountsError,
    phonesError,
    detail,
    detailLoading,
    detailError,
    loadAccounts,
    loadPhones,
    createAccount,
    updateAccount,
    deleteAccount,
    loadAccountDetail,
    clearAccountDetail,
    createPhone,
    updatePhone,
    deletePhone,
    usePhoneOnce,
  };
}
