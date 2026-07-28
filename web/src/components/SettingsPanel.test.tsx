/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { I18nProvider } from "../../../shared/i18n/context";

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({
    apiKey: "pwd",
    adminKeyConfigured: true,
    loaded: true,
    saving: false,
    saved: false,
    error: null,
    saveServiceKey: vi.fn(),
    rotateAdminKey: vi.fn(),
    load: vi.fn(),
  })),
}));

vi.mock("../../../shared/hooks/use-settings", () => mockSettings);

import { SettingsPanel } from "./SettingsPanel";

afterEach(cleanup);

describe("SettingsPanel credential separation", () => {
  it("shows separate service and admin controls without rendering the current admin key", () => {
    const { container } = render(<I18nProvider><SettingsPanel /></I18nProvider>);
    fireEvent.click(screen.getByText("Settings"));

    expect(screen.getByText("Service API Key")).toBeTruthy();
    expect(screen.getByText("Dashboard/Admin Key")).toBeTruthy();
    expect((screen.getByPlaceholderText("Service API Key") as HTMLInputElement).value).toBe("pwd");

    const adminInput = screen.getByPlaceholderText("Enter a new Dashboard/Admin key") as HTMLInputElement;
    expect(adminInput.value).toBe("");
    expect(adminInput.autocomplete).toBe("new-password");
    expect(container.textContent).not.toContain("current-admin-key");
  });
});
