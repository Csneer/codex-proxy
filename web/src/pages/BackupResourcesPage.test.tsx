/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../shared/i18n/context";
import { BackupResourcesPage } from "./BackupResourcesPage";

const mocks = vi.hoisted(() => ({
  loadAccountDetail: vi.fn(),
  updateAccount: vi.fn(),
  createPhone: vi.fn(),
  clearAccountDetail: vi.fn(),
  account: {
    id: "backup-1",
    email: "spare@example.com",
    note: "short-lived",
    hasEmailPassword: true,
    hasChatgptPassword: true,
    hasTotpSecret: false,
    hasEmailCodeUrl: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
  },
  detail: {
    id: "backup-1",
    email: "spare@example.com",
    note: "short-lived",
    hasEmailPassword: true,
    hasChatgptPassword: true,
    hasTotpSecret: false,
    hasEmailCodeUrl: false,
    emailPassword: "mail-secret",
    chatgptPassword: "chatgpt-secret",
    totpSecret: null,
    emailCodeUrl: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
  },
}));

vi.mock("../../../shared/hooks/use-backup-resources", () => ({
  useBackupResources: () => ({
    accounts: [mocks.account],
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

  it("omits untouched secret fields from an account edit", async () => {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledTimes(1));
    expect(mocks.updateAccount).toHaveBeenCalledWith("backup-1", {
      email: "spare@example.com",
      note: "short-lived",
    });
  });

  it("always exposes separate account and phone creation actions", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Add backup account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add SMS number" })).toBeTruthy();
  });

  it("renders the desktop account list on the shared glass surface", () => {
    renderPage();

    expect(screen.getByRole("table").parentElement?.classList.contains("glass-surface")).toBe(true);
  });

  it("selects the phone tab and opens the phone form from the header action", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add SMS number" }));

    expect(screen.getByRole("tab", { name: "SMS numbers" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Add SMS number" })).toBeTruthy();
  });
});
