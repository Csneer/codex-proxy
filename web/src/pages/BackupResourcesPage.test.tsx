/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../shared/i18n/context";
import { BackupResourcesPage } from "./BackupResourcesPage";

const mocks = vi.hoisted(() => ({
  loadAccountDetail: vi.fn(),
  updateAccount: vi.fn(),
  createPhone: vi.fn(),
  clearAccountDetail: vi.fn(),
  promoteAccount: vi.fn(),
  extraAccounts: [] as Array<Record<string, unknown>>,
  account: {
    id: "backup-1",
    email: "spare@example.com",
    accountStatus: "plus" as const,
    lifecycleStatus: "registered" as const,
    sourceSystem: "mail_dashboard" as const,
    sourceActive: true,
    revision: 4,
    lastMailSyncedAt: "2026-08-01T12:00:00.000Z",
    note: "short-lived",
    hasEmailPassword: true,
    hasChatgptPassword: true,
    hasTotpSecret: false,
    hasEmailCodeUrl: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    promotion: {
      id: "promotion-1",
      accountId: "backup-1",
      idempotencyKey: "promotion-key-1",
      mode: "ephemeral" as const,
      state: "failed" as const,
      coreAccountId: null,
      errorCode: "core_import_failed",
      createdAt: "2026-08-01T12:30:00.000Z",
      updatedAt: "2026-08-01T12:31:00.000Z",
    },
  },
  detail: {
    id: "backup-1",
    email: "spare@example.com",
    accountStatus: "plus" as const,
    lifecycleStatus: "registered" as const,
    sourceSystem: "mail_dashboard" as const,
    sourceActive: true,
    revision: 4,
    lastMailSyncedAt: "2026-08-01T12:00:00.000Z",
    note: "short-lived",
    hasEmailPassword: true,
    hasChatgptPassword: true,
    hasTotpSecret: false,
    hasEmailCodeUrl: false,
    emailPassword: "mail-secret",
    chatgptPassword: "chatgpt-secret",
    totpSecret: "totp-secret",
    emailCodeUrl: "https://mail.example/code",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    promotion: null,
  },
}));

vi.mock("../../../shared/hooks/use-backup-resources", () => ({
  useBackupResources: () => ({
    accounts: [mocks.account, ...mocks.extraAccounts],
    phones: [],
    accountsLoading: false,
    phonesLoading: false,
    accountsError: null,
    phonesError: null,
    detail: mocks.detail,
    detailLoading: false,
    detailError: null,
    loadAccounts: vi.fn(),
    loadPhones: vi.fn(),
    createAccount: vi.fn(),
    updateAccount: mocks.updateAccount,
    deleteAccount: vi.fn(),
    promoteAccount: mocks.promoteAccount,
    loadAccountDetail: mocks.loadAccountDetail,
    clearAccountDetail: mocks.clearAccountDetail,
    createPhone: mocks.createPhone,
    updatePhone: vi.fn(),
    deletePhone: vi.fn(),
    usePhoneOnce: vi.fn(),
  }),
}));

function renderPage() {
  return render(<I18nProvider><BackupResourcesPage /></I18nProvider>);
}

beforeEach(() => {
  localStorage.setItem("codex-proxy-lang", "en");
  mocks.loadAccountDetail.mockReset();
  mocks.updateAccount.mockReset().mockResolvedValue(undefined);
  mocks.createPhone.mockReset().mockResolvedValue(undefined);
  mocks.clearAccountDetail.mockReset();
  mocks.promoteAccount.mockReset().mockResolvedValue(undefined);
  mocks.extraAccounts.splice(0);
});

afterEach(cleanup);

describe("BackupResourcesPage", () => {
  it("requests credentials only when the user opens account details", () => {
    renderPage();

    expect(mocks.loadAccountDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0]!);

    expect(mocks.loadAccountDetail).toHaveBeenCalledWith("backup-1");
  });

  it("uses the shared inset surface for secret and note detail blocks", () => {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0]!);

    const dialog = screen.getByRole("dialog", { name: "Account details" });
    expect(dialog.querySelectorAll(".inset-surface")).toHaveLength(5);
  });

  it("exposes a visible copy action for every populated detail value", () => {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0]!);

    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(6);
  });

  it("omits untouched secret fields from an account edit", async () => {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledTimes(1));
    expect(mocks.updateAccount).toHaveBeenCalledWith("backup-1", {
      email: "spare@example.com",
      accountStatus: "plus",
      note: "short-lived",
    });
  });

  it("shows and manually updates the persisted account status", async () => {
    renderPage();

    expect(screen.getAllByText("Plus").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    fireEvent.change(screen.getByRole("combobox", { name: "Account status" }), { target: { value: "pro" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith("backup-1", {
      email: "spare@example.com",
      accountStatus: "pro",
      note: "short-lived",
    }));
  });

  it("always exposes separate account and phone creation actions", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Add backup account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add SMS number" })).toBeTruthy();
  });

  it("renders the desktop account list on the shared glass surface", () => {
    renderPage();

    const table = screen.getByRole("table");
    expect(table.parentElement?.classList.contains("glass-surface")).toBe(true);
    expect(table.parentElement?.classList.contains("overflow-x-auto")).toBe(false);
    expect(table.classList.contains("table-fixed")).toBe(true);
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Email",
      "Account status",
      "Source",
      "Actions",
    ]);
    for (const removed of ["Email password", "ChatGPT password", "TOTP", "Email code URL", "Revision", "Last mail sync"]) {
      expect(within(table).queryByRole("columnheader", { name: removed })).toBeNull();
    }
  });

  it("filters, searches, and sorts accounts by entry time", () => {
    mocks.extraAccounts.push({
      ...mocks.account,
      id: "backup-2",
      email: "fresh@example.com",
      note: "fresh inventory",
      accountStatus: "free",
      lifecycleStatus: "available",
      createdAt: "2026-08-02T10:00:00.000Z",
      promotion: null,
    });
    renderPage();

    let rows = screen.getByRole("table").querySelectorAll("tbody tr");
    expect(rows[0]?.textContent).toContain("fresh@example.com");

    fireEvent.change(screen.getByRole("combobox", { name: "Entry time sort" }), { target: { value: "oldest" } });
    rows = screen.getByRole("table").querySelectorAll("tbody tr");
    expect(rows[0]?.textContent).toContain("spare@example.com");

    fireEvent.change(screen.getByRole("combobox", { name: "Lifecycle filter" }), { target: { value: "available" } });
    expect(screen.getByRole("table").textContent).toContain("fresh@example.com");
    expect(screen.getByRole("table").textContent).not.toContain("spare@example.com");

    fireEvent.change(screen.getByRole("combobox", { name: "Account status filter" }), { target: { value: "plus" } });
    expect(screen.getByText("No backup accounts match the current filters.")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Account status filter" }), { target: { value: "free" } });

    fireEvent.input(screen.getByRole("searchbox", { name: "Search accounts" }), { target: { value: "no-result" } });
    expect(screen.getByText("No backup accounts match the current filters.")).toBeTruthy();
  });

  it("shows sanitized account-factory status metadata in both responsive layouts", () => {
    renderPage();

    expect(screen.getAllByText("Lifecycle").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Registered").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Source").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Mail dashboard · Active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Revision").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Last mail sync").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Aug 1, 2026/).length).toBeGreaterThan(0);
  });

  it("shows promotion state and retries only after an explicit click", async () => {
    renderPage();

    expect(screen.getAllByText(/failed · ephemeral · core_import_failed/).length).toBeGreaterThan(0);
    expect(mocks.promoteAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry promotion" })[0]!);

    await waitFor(() => expect(mocks.promoteAccount).toHaveBeenCalledWith(mocks.account));
    expect(screen.getByRole("status").textContent).toContain("Promotion updated");
  });

  it("uses visible safe fallbacks for unassigned inactive source metadata", () => {
    mocks.account.sourceSystem = null;
    mocks.account.sourceActive = false;
    mocks.account.lastMailSyncedAt = null;
    mocks.detail.sourceSystem = null;
    mocks.detail.sourceActive = false;
    mocks.detail.lastMailSyncedAt = null;

    renderPage();

    expect(screen.getAllByText("Not set").length).toBeGreaterThan(0);
    expect(screen.queryByText("Not set · Inactive")).toBeNull();

    mocks.account.sourceSystem = "mail_dashboard";
    mocks.account.sourceActive = true;
    mocks.account.lastMailSyncedAt = "2026-08-01T12:00:00.000Z";
    mocks.detail.sourceSystem = "mail_dashboard";
    mocks.detail.sourceActive = true;
    mocks.detail.lastMailSyncedAt = "2026-08-01T12:00:00.000Z";
  });

  it("selects the phone tab and opens the phone form from the header action", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add SMS number" }));

    expect(screen.getByRole("tab", { name: "SMS numbers" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Add SMS number" })).toBeTruthy();
  });
});
