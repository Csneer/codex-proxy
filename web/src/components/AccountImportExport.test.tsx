/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/preact";

const mockI18n = vi.hoisted(() => ({
  useT: vi.fn(),
}));

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => mockI18n.useT(),
}));

import { AccountImportExport } from "./AccountImportExport";

const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);

describe("AccountImportExport", () => {
  beforeEach(() => {
    mockI18n.useT.mockReturnValue((key: string) => key);
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) },
      close: { configurable: true, value: vi.fn(function (this: HTMLDialogElement) {
        this.open = false;
        this.dispatchEvent(new Event("close"));
      }) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    for (const method of ["showModal", "close"] as const) {
      if (dialogMethods[method]) Object.defineProperty(HTMLDialogElement.prototype, method, dialogMethods[method]);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    }
  });

  it("submits long pasted JSON intact, blocks duplicates, and clears credentials on success", async () => {
    let finish!: (result: { success: boolean; added: number; updated: number; failed: number; errors: string[] }) => void;
    const onImport = vi.fn(() => new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; }));
    render(<AccountImportExport onExport={vi.fn()} onImport={onImport} selectedIds={new Set()} />);
    fireEvent.click(screen.getByRole("button", { name: "accountImportText" }));
    const textarea = screen.getByLabelText("accountImportTextLabel") as HTMLTextAreaElement;
    const submit = within(screen.getByRole("dialog")).getByRole("button", { name: "importBtn" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.input(textarea, { target: { value: " \n " } });
    expect(submit.disabled).toBe(true);
    const payload = JSON.stringify({ credentials: { access_token: "x".repeat(120_000) } });
    fireEvent.input(textarea, { target: { value: payload } });
    fireEvent.submit(submit.closest("form")!);
    fireEvent.submit(submit.closest("form")!);
    expect(onImport).toHaveBeenCalledExactlyOnceWith(payload);
    expect(textarea.disabled).toBe(true);
    const cancel = new Event("cancel", { cancelable: true });
    screen.getByRole("dialog").dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    finish({ success: true, added: 0, updated: 1, failed: 0, errors: [] });
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(screen.getByRole("status").textContent).toContain("accountImportResult");
  });

  it.each(["partial", "http", "network"])("retains input on %s failure and clears it on close", async (kind) => {
    const onImport = vi.fn(async () => {
      if (kind === "network") throw new Error("network");
      return { success: kind === "partial", added: 0, updated: 0, failed: 1, errors: ["Invalid token"] };
    });
    render(<AccountImportExport onExport={vi.fn()} onImport={onImport} selectedIds={new Set()} />);
    const trigger = screen.getByRole("button", { name: "accountImportText" });
    fireEvent.click(trigger);
    const textarea = screen.getByLabelText("accountImportTextLabel") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "test.token.value" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "importBtn" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(kind === "network" ? "accountImportError" : "Invalid token"));
    expect(textarea.value).toBe("test.token.value");
    fireEvent.click(screen.getByRole("button", { name: "cancelBtn" }));
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("exports with the selected compatibility format", async () => {
    const onExport = vi.fn(async () => undefined);

    render(
      <AccountImportExport
        onExport={onExport}
        onImport={vi.fn()}
        selectedIds={new Set(["acct-1"])}
      />,
    );

    fireEvent.change(screen.getByLabelText("exportFormat"), {
      target: { value: "sub2api" },
    });
    fireEvent.click(screen.getByTitle("exportBtn (1)"));

    await waitFor(() => {
      expect(onExport).toHaveBeenCalledWith(["acct-1"], "sub2api");
    });
  });

  it("shows the first concrete import error instead of only the failed count", async () => {
    const onImport = vi.fn(async () => ({
      success: true,
      added: 0,
      updated: 0,
      failed: 1,
      errors: ["Account identity discovery failed: HTTP 403"],
    }));
    const { container } = render(
      <AccountImportExport
        onExport={vi.fn()}
        onImport={onImport}
        selectedIds={new Set()}
      />,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["{}"], "account.json", { type: "application/json" });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/Account identity discovery failed: HTTP 403/)).toBeTruthy();
    });
  });
});
