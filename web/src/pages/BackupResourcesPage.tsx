import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { useI18n, useT } from "../../../shared/i18n/context";
import {
  useBackupResources,
  type BackupAccount,
  type BackupAccountDetail,
  type BackupAccountInput,
  type BackupAccountLifecycleStatus,
  type BackupAccountSourceSystem,
  type BackupAccountStatus,
  type BackupTotpCode,
  type SmsNumber,
  type SmsNumberInput,
} from "../../../shared/hooks/use-backup-resources";
import { CopyButton } from "../components/CopyButton";

type ResourceTab = "accounts" | "phones";
type SecretField =
  | "emailPassword"
  | "chatgptPassword"
  | "totpSecret"
  | "emailCodeUrl"
  | "session"
  | "accessToken"
  | "refreshToken";
type AccountStatusFilter = "all" | BackupAccountStatus;
type AccountLifecycleFilter = "all" | BackupAccountLifecycleStatus;
type AccountSort = "created-newest" | "created-oldest" | "updated-newest" | "updated-oldest";

const inputClass = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-border-dark dark:bg-bg-dark dark:text-text-main";
const buttonBase = "min-h-10 rounded-lg border px-3 py-2 text-xs font-medium transition";
const secondaryButton = `${buttonBase} border-gray-200 text-muted hover:border-primary/40 hover:text-primary dark:border-border-dark`;
const dangerButton = `${buttonBase} border-gray-200 text-red-500 hover:border-red-300 hover:text-red-600 dark:border-border-dark dark:text-red-400`;
const primaryButton = "min-h-10 rounded-lg bg-primary-action px-4 py-2 text-xs font-semibold text-white transition hover:bg-primary-action-hover disabled:cursor-not-allowed disabled:opacity-60";
const accountStatuses: BackupAccountStatus[] = ["plus", "free", "unregistered", "pro"];
const lifecycleStatuses: BackupAccountLifecycleStatus[] = ["available", "leased", "registering", "registered", "promoted", "invalid", "retired"];

function formatDate(value: string, lang: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function Modal({
  title,
  children,
  onClose,
  layerClass = "z-[80]",
}: {
  title: string;
  children: ComponentChildren;
  onClose: () => void;
  layerClass?: string;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div
      class={`fixed inset-0 ${layerClass} flex items-center justify-center bg-slate-950/35 p-3 backdrop-blur-sm`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <button type="button" class="absolute inset-0 cursor-default" aria-label="Close" onClick={onClose} />
      <div class="glass-surface relative max-h-[calc(100dvh-24px)] w-full max-w-2xl overflow-x-hidden overflow-y-auto rounded-2xl p-5 shadow-2xl md:p-6">
        <div class="mb-5 flex items-center justify-between gap-3">
          <h2 class="text-section font-semibold text-main">{title}</h2>
          <button ref={closeButtonRef} type="button" class={secondaryButton} onClick={onClose} aria-label="Close">×</button>
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

function accountStatusLabel(status: BackupAccountStatus, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "plus": return t("backupStatusPlus");
    case "free": return t("backupStatusFree");
    case "pro": return t("backupStatusPro");
    case "unregistered": return t("backupStatusUnregistered");
  }
}

function AccountStatusBadge({ status }: { status: BackupAccountStatus }) {
  const t = useT();
  const styles: Record<BackupAccountStatus, string> = {
    plus: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    free: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
    unregistered: "bg-slate-100 text-slate-500 dark:bg-border-dark dark:text-text-dim",
    pro: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  };
  return (
    <span class={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-semibold ${styles[status]}`}>
      {accountStatusLabel(status, t)}
    </span>
  );
}

function lifecycleLabel(status: BackupAccountLifecycleStatus, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "available": return t("backupLifecycleAvailable");
    case "leased": return t("backupLifecycleLeased");
    case "registering": return t("backupLifecycleRegistering");
    case "registered": return t("backupLifecycleRegistered");
    case "promoted": return t("backupLifecyclePromoted");
    case "invalid": return t("backupLifecycleInvalid");
    case "retired": return t("backupLifecycleRetired");
  }
}

function sourceLabel(source: BackupAccountSourceSystem | null, t: ReturnType<typeof useT>): string {
  if (source === "mail_dashboard") return t("backupSourceMailDashboard");
  if (source === "extension") return t("backupSourceExtension");
  if (source === "manual") return t("backupSourceManual");
  return t("backupSourceUnset");
}

function AccountFactoryMetadata({ account }: { account: BackupAccount }) {
  const t = useT();
  const { lang } = useI18n();
  const sourceState = account.sourceActive ? t("backupSourceActive") : t("backupSourceInactive");
  const source = account.sourceSystem ? `${sourceLabel(account.sourceSystem, t)} · ${sourceState}` : sourceLabel(null, t);
  const lastMailSync = account.lastMailSyncedAt ? formatDate(account.lastMailSyncedAt, lang) : t("backupNotSet");
  const promotion = account.promotion;

  return (
    <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs text-muted">
      <div><dt>{t("backupLifecycle")}</dt><dd class="mt-0.5 font-medium text-main">{lifecycleLabel(account.lifecycleStatus, t)}</dd></div>
      <div><dt>{t("backupSource")}</dt><dd class="mt-0.5 font-medium text-main">{source}</dd></div>
      <div><dt>{t("backupRevision")}</dt><dd class="mt-0.5 font-medium text-main">{account.revision}</dd></div>
      <div><dt>{t("backupLastMailSynced")}</dt><dd class="mt-0.5 font-medium text-main">{lastMailSync}</dd></div>
      <div class="col-span-2"><dt>{t("backupPromotion")}</dt><dd class="mt-0.5 break-all font-medium text-main">{promotion ? `${promotion.state} · ${promotion.mode}${promotion.coreAccountId ? ` · ${promotion.coreAccountId}` : ""}${promotion.errorCode ? ` · ${promotion.errorCode}` : ""}` : t("backupNotSet")}</dd></div>
    </dl>
  );
}

function SecretInput({
  label,
  value,
  onInput,
  hasExisting,
  clear,
  onClear,
  multiline = false,
}: {
  label: string;
  value: string;
  onInput: (value: string) => void;
  hasExisting: boolean;
  clear: boolean;
  onClear: (clear: boolean) => void;
  multiline?: boolean;
}) {
  const t = useT();
  const placeholder = hasExisting ? t("backupSecretKeepPlaceholder") : t("backupSecretOptionalPlaceholder");
  return (
    <Field label={label}>
      {multiline ? (
        <textarea
          aria-label={label}
          class={`${inputClass} min-h-28 resize-y font-mono`}
          value={value}
          disabled={clear}
          placeholder={placeholder}
          onInput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)}
        />
      ) : (
        <input
          aria-label={label}
          class={inputClass}
          type="password"
          autocomplete="new-password"
          value={value}
          disabled={clear}
          placeholder={placeholder}
          onInput={(event) => onInput((event.currentTarget as HTMLInputElement).value)}
        />
      )}
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
  const [accountStatus, setAccountStatus] = useState<BackupAccountStatus>(account?.accountStatus ?? "unregistered");
  const [note, setNote] = useState(account?.note ?? "");
  const [secrets, setSecrets] = useState<Record<SecretField, string>>({
    emailPassword: "",
    chatgptPassword: "",
    totpSecret: "",
    emailCodeUrl: "",
    session: "",
    accessToken: "",
    refreshToken: "",
  });
  const [cleared, setCleared] = useState<Record<SecretField, boolean>>({
    emailPassword: false,
    chatgptPassword: false,
    totpSecret: false,
    emailCodeUrl: false,
    session: false,
    accessToken: false,
    refreshToken: false,
  });

  const hasExisting: Record<SecretField, boolean> = {
    emailPassword: account?.hasEmailPassword ?? false,
    chatgptPassword: account?.hasChatgptPassword ?? false,
    totpSecret: account?.hasTotpSecret ?? false,
    emailCodeUrl: account?.hasEmailCodeUrl ?? false,
    session: account?.hasSession ?? false,
    accessToken: account?.hasAccessToken ?? false,
    refreshToken: account?.hasRefreshToken ?? false,
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    const input: BackupAccountInput = { email: email.trim(), accountStatus, note: note.trim() };
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
        <Field label={t("backupAccountStatus")}>
          <select
            class={inputClass}
            value={accountStatus}
            onChange={(event) => setAccountStatus((event.currentTarget as HTMLSelectElement).value as BackupAccountStatus)}
          >
            {accountStatuses.map((status) => <option key={status} value={status}>{accountStatusLabel(status, t)}</option>)}
          </select>
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
          <SecretInput label={t("backupAccessToken")} value={secrets.accessToken} hasExisting={hasExisting.accessToken} clear={cleared.accessToken}
            onInput={(value) => setSecrets((current) => ({ ...current, accessToken: value }))}
            onClear={(clear) => setCleared((current) => ({ ...current, accessToken: clear }))} />
          <SecretInput label={t("backupRefreshToken")} value={secrets.refreshToken} hasExisting={hasExisting.refreshToken} clear={cleared.refreshToken}
            onInput={(value) => setSecrets((current) => ({ ...current, refreshToken: value }))}
            onClear={(clear) => setCleared((current) => ({ ...current, refreshToken: clear }))} />
        </div>
        <SecretInput label={t("backupSession")} value={secrets.session} hasExisting={hasExisting.session} clear={cleared.session} multiline
          onInput={(value) => setSecrets((current) => ({ ...current, session: value }))}
          onClear={(clear) => setCleared((current) => ({ ...current, session: clear }))} />
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

function SecretDetail({ label, value, extraAction }: { label: string; value: string | null; extraAction?: ComponentChildren }) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  return (
    <div class="inset-surface min-w-0 rounded-xl p-3">
      <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span class="text-muted min-w-0 text-xs font-medium">{label}</span>
        {value && (
          <div class="flex max-w-full flex-wrap items-center justify-end gap-1">
            {extraAction}
            <button class="min-h-10 px-2 text-xs font-medium text-primary" onClick={() => setRevealed((current) => !current)}>
              {revealed ? t("backupHideSecret") : t("backupRevealSecret")}
            </button>
            <CopyButton getText={() => value} variant="label" class="shrink-0" />
          </div>
        )}
      </div>
      <p class="min-w-0 break-all font-mono text-xs text-main">{value ? (revealed ? value : "••••••••••••") : t("backupNotSet")}</p>
    </div>
  );
}

function TotpCodeModal({
  account,
  loadTotpCode,
  onClose,
}: {
  account: BackupAccountDetail;
  loadTotpCode: (id: string) => Promise<BackupTotpCode>;
  onClose: () => void;
}) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<BackupTotpCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadTotpCode(account.id);
      setSnapshot(next);
      setNow(Date.now());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [account.id, loadTotpCode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const timer = window.setTimeout(() => void refresh(), Math.max(0, snapshot.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [refresh, snapshot]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => void refresh(), 5000);
    return () => window.clearTimeout(timer);
  }, [error, refresh]);

  const remainingSeconds = snapshot
    ? Math.max(0, Math.ceil((snapshot.expiresAt - now) / 1000))
    : 0;
  const codeCurrent = Boolean(snapshot && remainingSeconds > 0);
  const progress = snapshot
    ? Math.min(100, Math.max(0, (remainingSeconds / snapshot.period) * 100))
    : 0;

  return (
    <Modal title={t("backupTotpCodeTitle")} onClose={onClose} layerClass="z-[100]">
      <div class="grid gap-5">
        <div>
          <p class="text-muted text-xs">{t("backupEmail")}</p>
          <p class="mt-1 break-all text-sm font-semibold text-main">{account.email}</p>
        </div>

        <div class="inset-surface rounded-xl p-5 text-center" aria-busy={loading}>
          <p class="text-muted text-xs">{t("backupTotpCodeLabel")}</p>
          <p
            data-testid="backup-totp-code"
            class="mt-3 font-mono text-5xl font-semibold tracking-[.18em] text-main tabular-nums sm:text-6xl"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {codeCurrent ? snapshot!.code : "------"}
          </p>
          <p class="mt-3 text-xs text-muted">
            {loading && !snapshot
              ? t("backupTotpLoading")
              : codeCurrent
                ? t("backupTotpExpiresIn", { count: remainingSeconds })
                : t("backupTotpExpired")}
          </p>
          <div
            class="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-border-dark"
            role="progressbar"
            aria-label={t("backupTotpProgress")}
            aria-valuemin={0}
            aria-valuemax={snapshot?.period ?? 30}
            aria-valuenow={remainingSeconds}
          >
            <div class="h-full rounded-full bg-primary-action transition-[width] duration-1000" style={{ width: `${progress}%` }} />
          </div>
        </div>

        {error && (
          <div role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            <p>{error}</p>
            <button type="button" class="mt-2 min-h-10 font-medium underline" onClick={() => void refresh()}>
              {t("backupRetry")}
            </button>
          </div>
        )}

        <div class="flex flex-wrap justify-end gap-2">
          {codeCurrent && <CopyButton getText={() => snapshot!.code} variant="label" />}
          <button type="button" class={secondaryButton} disabled={loading} onClick={() => void refresh()}>
            {loading ? t("backupTotpRefreshing") : t("refresh")}
          </button>
        </div>
        <p class="text-xs leading-5 text-muted">{t("backupTotpCodeHint")}</p>
      </div>
    </Modal>
  );
}

function AccountDetail({ resources, onClose }: { resources: ReturnType<typeof useBackupResources>; onClose: () => void }) {
  const t = useT();
  const [totpOpen, setTotpOpen] = useState(false);
  const detail = resources.detail;
  return (
    <>
      <Modal title={t("backupAccountDetail")} onClose={() => { setTotpOpen(false); onClose(); }}>
      {resources.detailLoading && <div class="py-12 text-center text-sm text-slate-400">{t("backupLoadingDetail")}</div>}
      {resources.detailError && <div role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">{resources.detailError}</div>}
      {detail && (
        <div class="grid min-w-0 gap-3">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <p class="text-muted text-xs">{t("backupEmail")}</p>
              <p class="mt-1 break-all text-sm font-semibold text-main">{detail.email}</p>
              <div class="mt-2"><AccountStatusBadge status={detail.accountStatus} /></div>
            </div>
            <CopyButton getText={() => detail.email} variant="label" class="shrink-0" />
          </div>
          <SecretDetail label={t("backupEmailPassword")} value={detail.emailPassword} />
          <SecretDetail label={t("backupChatgptPassword")} value={detail.chatgptPassword} />
          <SecretDetail
            label={t("backupTotpSecret")}
            value={detail.totpSecret}
            extraAction={
              <button type="button" class="min-h-10 px-2 text-xs font-medium text-primary" onClick={() => setTotpOpen(true)}>
                {t("backupViewTotpCode")}
              </button>
            }
          />
          <SecretDetail label={t("backupEmailCodeUrl")} value={detail.emailCodeUrl} />
          <SecretDetail label={t("backupSession")} value={detail.session} />
          <SecretDetail label={t("backupAccessToken")} value={detail.accessToken} />
          <SecretDetail label={t("backupRefreshToken")} value={detail.refreshToken} />
          <div class="inset-surface min-w-0 rounded-xl p-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-muted text-xs">{t("backupNote")}</p>
                <p class="mt-1 break-all whitespace-pre-wrap text-sm text-main">{detail.note || t("backupNoNote")}</p>
              </div>
              {detail.note && <CopyButton getText={() => detail.note} variant="label" class="shrink-0" />}
            </div>
          </div>
        </div>
      )}
      </Modal>
      {totpOpen && detail?.totpSecret && (
        <TotpCodeModal account={detail} loadTotpCode={resources.loadTotpCode} onClose={() => setTotpOpen(false)} />
      )}
    </>
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
  const [accountSearch, setAccountSearch] = useState("");
  const [accountStatusFilter, setAccountStatusFilter] = useState<AccountStatusFilter>("all");
  const [accountLifecycleFilter, setAccountLifecycleFilter] = useState<AccountLifecycleFilter>("all");
  const [accountSort, setAccountSort] = useState<AccountSort>("created-newest");

  const visibleAccounts = useMemo(() => {
    const query = accountSearch.trim().toLocaleLowerCase();
    return resources.accounts
      .filter((account) => accountStatusFilter === "all" || account.accountStatus === accountStatusFilter)
      .filter((account) => accountLifecycleFilter === "all" || account.lifecycleStatus === accountLifecycleFilter)
      .filter((account) => {
        if (!query) return true;
        return [
          account.email,
          account.note,
          account.accountStatus,
          accountStatusLabel(account.accountStatus, t),
          account.lifecycleStatus,
          lifecycleLabel(account.lifecycleStatus, t),
          account.sourceSystem ?? "",
          sourceLabel(account.sourceSystem, t),
        ].some((value) => value.toLocaleLowerCase().includes(query));
      })
      .sort((left, right) => {
        const sortByUpdatedAt = accountSort === "updated-newest" || accountSort === "updated-oldest";
        const comparison = new Date(sortByUpdatedAt ? left.updatedAt : left.createdAt).getTime()
          - new Date(sortByUpdatedAt ? right.updatedAt : right.createdAt).getTime();
        const oldestFirst = accountSort === "created-oldest" || accountSort === "updated-oldest";
        return oldestFirst ? comparison : -comparison;
      });
  }, [accountLifecycleFilter, accountSearch, accountSort, accountStatusFilter, resources.accounts, t]);

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

  const promoteAccount = async (account: BackupAccount) => {
    setBusyId(account.id);
    try {
      await resources.promoteAccount(account);
      notify(t("backupPromotionStarted"));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusyId(null);
    }
  };

  const checkEligibility = async () => {
    setBusy(true);
    try {
      await resources.checkEligibility(visibleAccounts.filter((account) => account.hasAccessToken || account.hasSession).slice(0, 10).map((account) => account.id));
      notify("资格检测完成（最多 10 个账号）");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  const actionButtons = (account: BackupAccount) => (
    <div class="flex flex-wrap justify-end gap-1.5">
      {account.lifecycleStatus === "registered" && account.promotion?.state !== "linked" && (
        <button class={primaryButton} disabled={busyId === account.id} onClick={() => void promoteAccount(account)}>
          {account.promotion ? t("backupPromotionRetry") : t("backupPromote")}
        </button>
      )}
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
          {tab === "accounts" && <button class={secondaryButton} disabled={busy} onClick={() => void checkEligibility()}>检测资格（最多 10 个）</button>}
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
              <div class="glass-surface mb-3 grid gap-3 rounded-xl p-3 md:grid-cols-2 md:items-end xl:grid-cols-[minmax(220px,1fr)_180px_180px_180px_auto]">
                <Field label={t("backupSearchAccounts")}>
                  <input
                    type="search"
                    class={inputClass}
                    value={accountSearch}
                    placeholder={t("backupSearchAccountsPlaceholder")}
                    onInput={(event) => setAccountSearch((event.currentTarget as HTMLInputElement).value)}
                  />
                </Field>
                <Field label={t("backupAccountStatusFilter")}>
                  <select
                    class={inputClass}
                    value={accountStatusFilter}
                    onChange={(event) => setAccountStatusFilter((event.currentTarget as HTMLSelectElement).value as AccountStatusFilter)}
                  >
                    <option value="all">{t("filterAll")}</option>
                    {accountStatuses.map((status) => <option key={status} value={status}>{accountStatusLabel(status, t)}</option>)}
                  </select>
                </Field>
                <Field label={t("backupLifecycleFilter")}>
                  <select
                    class={inputClass}
                    value={accountLifecycleFilter}
                    onChange={(event) => setAccountLifecycleFilter((event.currentTarget as HTMLSelectElement).value as AccountLifecycleFilter)}
                  >
                    <option value="all">{t("filterAll")}</option>
                    {lifecycleStatuses.map((status) => <option key={status} value={status}>{lifecycleLabel(status, t)}</option>)}
                  </select>
                </Field>
                <Field label={t("backupAccountSort")}>
                  <select
                    class={inputClass}
                    value={accountSort}
                    onChange={(event) => setAccountSort((event.currentTarget as HTMLSelectElement).value as AccountSort)}
                  >
                    <option value="created-newest">{t("backupCreatedNewest")}</option>
                    <option value="created-oldest">{t("backupCreatedOldest")}</option>
                    <option value="updated-newest">{t("backupUpdatedNewest")}</option>
                    <option value="updated-oldest">{t("backupUpdatedOldest")}</option>
                  </select>
                </Field>
                <p class="pb-2 text-xs text-muted">{t("backupVisibleAccounts", { visible: visibleAccounts.length, total: resources.accounts.length })}</p>
              </div>

              {visibleAccounts.length === 0 ? <EmptyState text={t("backupNoMatchingAccounts")} /> : <>
                <div class="glass-surface hidden overflow-hidden rounded-xl md:block">
                <table aria-label={t("backupAccountsTab")} class="w-full table-fixed text-left text-xs">
                  <colgroup>
                    <col class="w-[36%]" />
                    <col class="w-[24%]" />
                    <col class="w-[16%]" />
                    <col class="w-[24%]" />
                  </colgroup>
                  <thead class="border-b border-gray-200 text-muted dark:border-border-dark">
                    <tr><th scope="col" class="px-4 py-3">{t("backupEmail")}</th><th scope="col" class="px-3 py-3">{t("backupAccountStatus")}</th><th scope="col" class="px-3 py-3">{t("backupSource")}</th><th scope="col" class="px-4 py-3 text-right">{t("backupActions")}</th></tr>
                  </thead>
                  <tbody class="divide-y divide-gray-100 dark:divide-border-dark">
                    {visibleAccounts.map((account) => (
                      <tr key={account.id} class="align-middle transition-colors hover:bg-primary-container/20">
                        <td class="min-w-0 px-4 py-3">
                          <p class="break-all font-medium text-main">{account.email}</p>
                          <p class="mt-1 truncate text-muted" title={account.note}>{account.note || t("backupNoNote")}</p>
                          <p class="mt-1 text-[11px] text-slate-400">{t("backupCreatedAt")}: {formatDate(account.createdAt, lang)}</p>
                          <p class="mt-1 text-[11px] text-slate-400">{t("backupUpdatedAt")}: {formatDate(account.updatedAt, lang)}</p>
                        </td>
                        <td class="px-3 py-3">
                          <AccountStatusBadge status={account.accountStatus} />
                          {account.eligibilityStatus && <span class="mt-1 inline-flex rounded bg-primary-container px-1.5 py-0.5 text-[10px] text-primary">资格: {account.eligibilityStatus}</span>}
                          <p class="mt-2 font-medium text-main">{lifecycleLabel(account.lifecycleStatus, t)}</p>
                          {account.promotion && <p class="mt-1 break-all text-[11px] text-muted">{account.promotion.state} · {account.promotion.mode}{account.promotion.errorCode ? ` · ${account.promotion.errorCode}` : ""}</p>}
                        </td>
                        <td class="break-words px-3 py-3 text-main">{account.sourceSystem ? `${sourceLabel(account.sourceSystem, t)} · ${account.sourceActive ? t("backupSourceActive") : t("backupSourceInactive")}` : sourceLabel(null, t)}</td>
                        <td class="px-4 py-3">{actionButtons(account)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div class="grid gap-3 md:hidden">
                {visibleAccounts.map((account) => (
                  <article key={account.id} class="glass-surface rounded-xl p-4">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <p class="min-w-0 flex-1 break-all text-sm font-semibold text-main">{account.email}</p>
                      <AccountStatusBadge status={account.accountStatus} />
                    </div>
                    <AccountFactoryMetadata account={account} />
                    <p class="mt-3 line-clamp-2 text-xs text-slate-500 dark:text-text-dim">{account.note || t("backupNoNote")}</p>
                    <p class="mt-3 text-[11px] text-slate-400">{t("backupCreatedAt")}: {formatDate(account.createdAt, lang)}</p>
                    <p class="mt-1 text-[11px] text-slate-400">{t("backupUpdatedAt")}: {formatDate(account.updatedAt, lang)}</p>
                    <div class="mt-3">{actionButtons(account)}</div>
                  </article>
                ))}
              </div>
              </>}
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
