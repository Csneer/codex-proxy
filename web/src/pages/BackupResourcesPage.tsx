import { useCallback, useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { useI18n, useT } from "../../../shared/i18n/context";
import {
  useBackupResources,
  type BackupAccount,
  type BackupAccountInput,
  type SmsNumber,
  type SmsNumberInput,
} from "../../../shared/hooks/use-backup-resources";
import { CopyButton } from "../components/CopyButton";

type ResourceTab = "accounts" | "phones";
type SecretField = "emailPassword" | "chatgptPassword" | "totpSecret" | "emailCodeUrl";

const inputClass = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-border-dark dark:bg-bg-dark dark:text-text-main";
const buttonBase = "min-h-10 rounded-lg border px-3 py-2 text-xs font-medium transition";
const secondaryButton = `${buttonBase} border-gray-200 text-muted hover:border-primary/40 hover:text-primary dark:border-border-dark`;
const dangerButton = `${buttonBase} border-gray-200 text-red-500 hover:border-red-300 hover:text-red-600 dark:border-border-dark dark:text-red-400`;
const primaryButton = "min-h-10 rounded-lg bg-primary-action px-4 py-2 text-xs font-semibold text-white transition hover:bg-primary-action-hover disabled:cursor-not-allowed disabled:opacity-60";

function formatDate(value: string, lang: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function Modal({ title, children, onClose }: { title: string; children: ComponentChildren; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div class="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/35 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title}>
      <button class="absolute inset-0 cursor-default" aria-label="Close" onClick={onClose} />
      <div class="glass-surface relative max-h-[calc(100dvh-24px)] w-full max-w-2xl overflow-y-auto rounded-2xl p-5 shadow-2xl md:p-6">
        <div class="mb-5 flex items-center justify-between gap-3">
          <h2 class="text-section font-semibold text-main">{title}</h2>
          <button class={secondaryButton} onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <label class="grid gap-1.5 text-xs font-medium text-slate-600 dark:text-text-dim">
      <span>{label}</span>
      {children}
    </label>
  );
}

function SecretInput({
  label,
  value,
  onInput,
  hasExisting,
  clear,
  onClear,
}: {
  label: string;
  value: string;
  onInput: (value: string) => void;
  hasExisting: boolean;
  clear: boolean;
  onClear: (clear: boolean) => void;
}) {
  const t = useT();
  return (
    <Field label={label}>
      <input
        class={inputClass}
        type="password"
        autocomplete="new-password"
        value={value}
        disabled={clear}
        placeholder={hasExisting ? t("backupSecretKeepPlaceholder") : t("backupSecretOptionalPlaceholder")}
        onInput={(event) => onInput((event.currentTarget as HTMLInputElement).value)}
      />
      {hasExisting && (
        <label class="mt-0.5 flex min-h-8 items-center gap-2 text-xs font-normal text-slate-500 dark:text-text-dim">
          <input type="checkbox" checked={clear} onChange={(event) => onClear((event.currentTarget as HTMLInputElement).checked)} />
          {t("backupRemoveExistingSecret")}
        </label>
      )}
    </Field>
  );
}

function AccountForm({
  account,
  busy,
  onClose,
  onSubmit,
}: {
  account: BackupAccount | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: BackupAccountInput) => Promise<void>;
}) {
  const t = useT();
  const [email, setEmail] = useState(account?.email ?? "");
  const [note, setNote] = useState(account?.note ?? "");
  const [secrets, setSecrets] = useState<Record<SecretField, string>>({ emailPassword: "", chatgptPassword: "", totpSecret: "", emailCodeUrl: "" });
  const [cleared, setCleared] = useState<Record<SecretField, boolean>>({ emailPassword: false, chatgptPassword: false, totpSecret: false, emailCodeUrl: false });

  const hasExisting: Record<SecretField, boolean> = {
    emailPassword: account?.hasEmailPassword ?? false,
    chatgptPassword: account?.hasChatgptPassword ?? false,
    totpSecret: account?.hasTotpSecret ?? false,
    emailCodeUrl: account?.hasEmailCodeUrl ?? false,
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    const input: BackupAccountInput = { email: email.trim(), note: note.trim() };
    for (const field of Object.keys(secrets) as SecretField[]) {
      if (cleared[field]) input[field] = null;
      else if (secrets[field] !== "" || !account) input[field] = secrets[field] || null;
    }
    await onSubmit(input);
  };

  return (
    <Modal title={account ? t("backupEditAccount") : t("backupAddAccount")} onClose={onClose}>
      <form class="grid gap-4" onSubmit={submit}>
        <Field label={t("backupEmail")}>
          <input class={inputClass} type="email" required autocomplete="off" value={email} onInput={(event) => setEmail((event.currentTarget as HTMLInputElement).value)} />
        </Field>
        <div class="grid gap-4 md:grid-cols-2">
          <SecretInput label={t("backupEmailPassword")} value={secrets.emailPassword} hasExisting={hasExisting.emailPassword} clear={cleared.emailPassword}
            onInput={(value) => setSecrets((current) => ({ ...current, emailPassword: value }))}
            onClear={(clear) => setCleared((current) => ({ ...current, emailPassword: clear }))} />
          <SecretInput label={t("backupChatgptPassword")} value={secrets.chatgptPassword} hasExisting={hasExisting.chatgptPassword} clear={cleared.chatgptPassword}
            onInput={(value) => setSecrets((current) => ({ ...current, chatgptPassword: value }))}
            onClear={(clear) => setCleared((current) => ({ ...current, chatgptPassword: clear }))} />
          <SecretInput label={t("backupTotpSecret")} value={secrets.totpSecret} hasExisting={hasExisting.totpSecret} clear={cleared.totpSecret}
            onInput={(value) => setSecrets((current) => ({ ...current, totpSecret: value }))}
            onClear={(clear) => setCleared((current) => ({ ...current, totpSecret: clear }))} />
          <SecretInput label={t("backupEmailCodeUrl")} value={secrets.emailCodeUrl} hasExisting={hasExisting.emailCodeUrl} clear={cleared.emailCodeUrl}
            onInput={(value) => setSecrets((current) => ({ ...current, emailCodeUrl: value }))}
            onClear={(clear) => setCleared((current) => ({ ...current, emailCodeUrl: clear }))} />
        </div>
        <Field label={t("backupNote")}>
          <textarea class={`${inputClass} min-h-24 resize-y`} value={note} onInput={(event) => setNote((event.currentTarget as HTMLTextAreaElement).value)} />
        </Field>
        <div class="flex justify-end gap-2">
          <button type="button" class={secondaryButton} disabled={busy} onClick={onClose}>{t("cancelBtn")}</button>
          <button type="submit" class={primaryButton} disabled={busy}>{busy ? t("submitting") : t("backupSave")}</button>
        </div>
      </form>
    </Modal>
  );
}

function PhoneForm({
  phone,
  busy,
  onClose,
  onSubmit,
}: {
  phone: SmsNumber | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: SmsNumberInput) => Promise<void>;
}) {
  const t = useT();
  const [phoneNumber, setPhoneNumber] = useState(phone?.phoneNumber ?? "");
  const [useCount, setUseCount] = useState(phone?.useCount ?? 0);
  const [note, setNote] = useState(phone?.note ?? "");
  const submit = async (event: Event) => {
    event.preventDefault();
    await onSubmit({ phoneNumber: phoneNumber.trim(), useCount, note: note.trim() });
  };
  return (
    <Modal title={phone ? t("backupEditPhone") : t("backupAddPhone")} onClose={onClose}>
      <form class="grid gap-4" onSubmit={submit}>
        <Field label={t("backupPhoneNumber")}>
          <input class={inputClass} type="tel" required autocomplete="off" value={phoneNumber} onInput={(event) => setPhoneNumber((event.currentTarget as HTMLInputElement).value)} />
        </Field>
        <Field label={t("backupUseCount")}>
          <input class={inputClass} type="number" min="0" step="1" required value={useCount} onInput={(event) => setUseCount(Math.max(0, Number((event.currentTarget as HTMLInputElement).value) || 0))} />
        </Field>
        <Field label={t("backupNote")}>
          <textarea class={`${inputClass} min-h-24 resize-y`} value={note} onInput={(event) => setNote((event.currentTarget as HTMLTextAreaElement).value)} />
        </Field>
        <div class="flex justify-end gap-2">
          <button type="button" class={secondaryButton} disabled={busy} onClick={onClose}>{t("cancelBtn")}</button>
          <button type="submit" class={primaryButton} disabled={busy}>{busy ? t("submitting") : t("backupSave")}</button>
        </div>
      </form>
    </Modal>
  );
}

function Presence({ present }: { present: boolean }) {
  const t = useT();
  return (
    <span class={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${present ? "bg-primary-container text-primary" : "bg-slate-100 text-slate-400 dark:bg-border-dark dark:text-text-dim"}`}>
      {present ? t("backupPresent") : t("backupMissing")}
    </span>
  );
}

function SecretDetail({ label, value }: { label: string; value: string | null }) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  return (
    <div class="inset-surface rounded-xl p-3">
      <div class="mb-1 flex items-center justify-between gap-3">
        <span class="text-muted text-xs font-medium">{label}</span>
        {value && (
          <div class="flex items-center gap-1">
            <button class="min-h-10 px-2 text-xs font-medium text-primary" onClick={() => setRevealed((current) => !current)}>
              {revealed ? t("backupHideSecret") : t("backupRevealSecret")}
            </button>
            <CopyButton getText={() => value} titleKey="copy" class="text-muted hover:text-primary" />
          </div>
        )}
      </div>
      <p class="break-all font-mono text-xs text-main">{value ? (revealed ? value : "••••••••••••") : t("backupNotSet")}</p>
    </div>
  );
}

function AccountDetail({ resources, onClose }: { resources: ReturnType<typeof useBackupResources>; onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t("backupAccountDetail")} onClose={onClose}>
      {resources.detailLoading && <div class="py-12 text-center text-sm text-slate-400">{t("backupLoadingDetail")}</div>}
      {resources.detailError && <div role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">{resources.detailError}</div>}
      {resources.detail && (
        <div class="grid gap-3">
          <div>
            <p class="text-muted text-xs">{t("backupEmail")}</p>
            <p class="mt-1 break-all text-sm font-semibold text-main">{resources.detail.email}</p>
          </div>
          <SecretDetail label={t("backupEmailPassword")} value={resources.detail.emailPassword} />
          <SecretDetail label={t("backupChatgptPassword")} value={resources.detail.chatgptPassword} />
          <SecretDetail label={t("backupTotpSecret")} value={resources.detail.totpSecret} />
          <SecretDetail label={t("backupEmailCodeUrl")} value={resources.detail.emailCodeUrl} />
          <div class="inset-surface rounded-xl p-3">
            <p class="text-muted text-xs">{t("backupNote")}</p>
            <p class="mt-1 whitespace-pre-wrap text-sm text-main">{resources.detail.note || t("backupNoNote")}</p>
          </div>
        </div>
      )}
    </Modal>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div class="glass-surface rounded-xl px-4 py-14 text-center text-sm text-slate-400 dark:text-text-dim">{text}</div>;
}

export function BackupResourcesPage() {
  const t = useT();
  const { lang } = useI18n();
  const resources = useBackupResources();
  const [tab, setTab] = useState<ResourceTab>("accounts");
  const [accountForm, setAccountForm] = useState<BackupAccount | null | undefined>(undefined);
  const [phoneForm, setPhoneForm] = useState<SmsNumber | null | undefined>(undefined);
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const notify = useCallback((text: string, error = false) => {
    setMessage({ text, error });
    window.setTimeout(() => setMessage(null), 3500);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailOpen(false);
    resources.clearAccountDetail();
  }, [resources.clearAccountDetail]);

  const openDetail = useCallback((id: string) => {
    setDetailOpen(true);
    void resources.loadAccountDetail(id);
  }, [resources.loadAccountDetail]);

  const saveAccount = async (input: BackupAccountInput) => {
    setBusy(true);
    try {
      if (accountForm) await resources.updateAccount(accountForm.id, input);
      else await resources.createAccount(input);
      setAccountForm(undefined);
      notify(t("backupSaved"));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  const savePhone = async (input: SmsNumberInput) => {
    setBusy(true);
    try {
      if (phoneForm) await resources.updatePhone(phoneForm.id, input);
      else await resources.createPhone(input);
      setPhoneForm(undefined);
      notify(t("backupSaved"));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  const removeAccount = async (account: BackupAccount) => {
    if (!window.confirm(t("backupDeleteAccountConfirm", { email: account.email }))) return;
    setBusyId(account.id);
    try {
      await resources.deleteAccount(account.id);
      notify(t("backupDeleted"));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusyId(null);
    }
  };

  const removePhone = async (phone: SmsNumber) => {
    if (!window.confirm(t("backupDeletePhoneConfirm", { phone: phone.phoneNumber }))) return;
    setBusyId(phone.id);
    try {
      await resources.deletePhone(phone.id);
      notify(t("backupDeleted"));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusyId(null);
    }
  };

  const incrementPhone = async (phone: SmsNumber) => {
    setBusyId(phone.id);
    try {
      await resources.usePhoneOnce(phone.id);
      notify(t("backupUseRecorded"));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusyId(null);
    }
  };

  const actionButtons = (account: BackupAccount) => (
    <div class="flex flex-wrap justify-end gap-1.5">
      <button class={secondaryButton} onClick={() => openDetail(account.id)}>{t("backupView")}</button>
      <button class={secondaryButton} onClick={() => setAccountForm(account)}>{t("backupEdit")}</button>
      <button class={dangerButton} disabled={busyId === account.id} onClick={() => void removeAccount(account)}>{t("backupDelete")}</button>
    </div>
  );

  return (
    <section class="flex flex-col gap-5">
      <div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <p class="text-meta uppercase tracking-[.16em] text-slate-500">BACKUP RESOURCES</p>
          <h1 class="mt-1 text-page-title font-semibold text-main">{t("backupResources")}</h1>
          <p class="mt-1 max-w-2xl text-reading text-slate-500 dark:text-text-dim">{t("backupResourcesDesc")}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class={secondaryButton} onClick={() => tab === "accounts" ? void resources.loadAccounts() : void resources.loadPhones()}>{t("refresh")}</button>
          <button class={primaryButton} onClick={() => { setTab("accounts"); setAccountForm(null); }}>{t("backupAddAccount")}</button>
          <button class={secondaryButton} onClick={() => { setTab("phones"); setPhoneForm(null); }}>{t("backupAddPhone")}</button>
        </div>
      </div>

      <div class="glass-surface flex gap-1 rounded-xl p-1" role="tablist">
        {(["accounts", "phones"] as ResourceTab[]).map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={tab === item}
            class={`min-h-10 flex-1 rounded-lg px-4 py-2 text-sm font-medium transition md:flex-none ${tab === item ? "bg-primary-container text-primary shadow-sm" : "text-main hover:bg-primary-container/60 hover:text-primary"}`}
            onClick={() => setTab(item)}
          >
            {item === "accounts" ? t("backupAccountsTab") : t("backupPhonesTab")}
          </button>
        ))}
      </div>

      {message && <div role="status" class={`rounded-lg px-4 py-3 text-sm ${message.error ? "bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400" : "bg-primary-container text-primary"}`}>{message.text}</div>}

      {tab === "accounts" && (
        <div>
          {resources.accountsLoading ? <EmptyState text={t("backupLoadingAccounts")} /> : resources.accountsError ? (
            <div role="alert" class="rounded-xl bg-red-50 p-4 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
              <p>{resources.accountsError}</p>
              <button class="mt-2 min-h-10 font-medium underline" onClick={() => void resources.loadAccounts()}>{t("backupRetry")}</button>
            </div>
          ) : resources.accounts.length === 0 ? <EmptyState text={t("backupEmptyAccounts")} /> : (
            <>
              <div class="glass-surface hidden overflow-x-auto rounded-xl md:block">
                <table class="w-full min-w-[920px] text-left text-xs">
                  <thead class="border-b border-gray-200 text-muted dark:border-border-dark">
                    <tr><th class="px-4 py-3">{t("backupEmail")}</th><th class="px-3 py-3">{t("backupEmailPassword")}</th><th class="px-3 py-3">{t("backupChatgptPassword")}</th><th class="px-3 py-3">TOTP</th><th class="px-3 py-3">{t("backupEmailCodeUrl")}</th><th class="px-3 py-3">{t("backupNote")}</th><th class="px-3 py-3">{t("updatedAt")}</th><th class="px-4 py-3 text-right">{t("backupActions")}</th></tr>
                  </thead>
                  <tbody class="divide-y divide-gray-100 dark:divide-border-dark">
                    {resources.accounts.map((account) => (
                      <tr key={account.id} class="align-middle transition-colors hover:bg-primary-container/20">
                        <td class="max-w-48 break-all px-4 py-3 font-medium text-main">{account.email}</td>
                        <td class="px-3 py-3"><Presence present={account.hasEmailPassword} /></td>
                        <td class="px-3 py-3"><Presence present={account.hasChatgptPassword} /></td>
                        <td class="px-3 py-3"><Presence present={account.hasTotpSecret} /></td>
                        <td class="px-3 py-3"><Presence present={account.hasEmailCodeUrl} /></td>
                        <td class="max-w-44 truncate px-3 py-3 text-muted" title={account.note}>{account.note || "—"}</td>
                        <td class="whitespace-nowrap px-3 py-3 text-muted">{formatDate(account.updatedAt, lang)}</td>
                        <td class="px-4 py-3">{actionButtons(account)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div class="grid gap-3 md:hidden">
                {resources.accounts.map((account) => (
                  <article key={account.id} class="glass-surface rounded-xl p-4">
                    <p class="break-all text-sm font-semibold text-main">{account.email}</p>
                    <p class="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-text-dim">{account.note || t("backupNoNote")}</p>
                    <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <span>{t("backupEmailPassword")}: <Presence present={account.hasEmailPassword} /></span>
                      <span>{t("backupChatgptPassword")}: <Presence present={account.hasChatgptPassword} /></span>
                      <span>TOTP: <Presence present={account.hasTotpSecret} /></span>
                      <span>{t("backupEmailCodeUrl")}: <Presence present={account.hasEmailCodeUrl} /></span>
                    </div>
                    <p class="mt-3 text-[11px] text-slate-400">{formatDate(account.updatedAt, lang)}</p>
                    <div class="mt-3">{actionButtons(account)}</div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === "phones" && (
        <div>
          {resources.phonesLoading ? <EmptyState text={t("backupLoadingPhones")} /> : resources.phonesError ? (
            <div role="alert" class="rounded-xl bg-red-50 p-4 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
              <p>{resources.phonesError}</p>
              <button class="mt-2 min-h-10 font-medium underline" onClick={() => void resources.loadPhones()}>{t("backupRetry")}</button>
            </div>
          ) : resources.phones.length === 0 ? <EmptyState text={t("backupEmptyPhones")} /> : (
            <div class="grid gap-3 lg:grid-cols-2">
              {resources.phones.map((phone) => (
                <article key={phone.id} class="glass-surface flex flex-col gap-3 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div class="min-w-0">
                    <p class="font-mono text-sm font-semibold tracking-wide text-main">{phone.phoneNumber}</p>
                    <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">{t("backupUsedTimes", { count: phone.useCount })}</p>
                    <p class="mt-2 line-clamp-2 text-xs text-slate-500 dark:text-text-dim">{phone.note || t("backupNoNote")}</p>
                    <p class="mt-2 text-[11px] text-slate-400">{formatDate(phone.updatedAt, lang)}</p>
                  </div>
                  <div class="flex shrink-0 flex-wrap justify-end gap-1.5">
                    <button class={primaryButton} disabled={busyId === phone.id} onClick={() => void incrementPhone(phone)}>{t("backupUseOnce")}</button>
                    <button class={secondaryButton} onClick={() => setPhoneForm(phone)}>{t("backupEdit")}</button>
                    <button class={dangerButton} disabled={busyId === phone.id} onClick={() => void removePhone(phone)}>{t("backupDelete")}</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {accountForm !== undefined && <AccountForm key={accountForm?.id ?? "new"} account={accountForm} busy={busy} onClose={() => setAccountForm(undefined)} onSubmit={saveAccount} />}
      {phoneForm !== undefined && <PhoneForm key={phoneForm?.id ?? "new"} phone={phoneForm} busy={busy} onClose={() => setPhoneForm(undefined)} onSubmit={savePhone} />}
      {detailOpen && <AccountDetail resources={resources} onClose={closeDetail} />}
    </section>
  );
}
