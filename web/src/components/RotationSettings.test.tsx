/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { I18nProvider } from "../../../shared/i18n/context";

const mock = vi.hoisted(() => ({
  save: vi.fn(),
  useRotationSettings: vi.fn(),
}));

vi.mock("../../../shared/hooks/use-settings", () => ({ useSettings: () => ({ apiKey: "pwd" }) }));
vi.mock("../../../shared/hooks/use-rotation-settings", () => ({
  useRotationSettings: mock.useRotationSettings,
}));

import { RotationSettings } from "./RotationSettings";

function renderSettings(percent = 30) {
  mock.useRotationSettings.mockReturnValue({
    data: { rotation_strategy: "least_used", quota_batch_percent: percent },
    saving: false,
    saved: false,
    error: null,
    save: mock.save,
  });
  render(<I18nProvider><RotationSettings /></I18nProvider>);
  fireEvent.click(screen.getByText("Account Selection"));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.setItem("codex-proxy-lang", "en");
});

describe("RotationSettings quota batch", () => {
  it("reveals the percentage input only after selecting quota batch", () => {
    renderSettings();
    expect(screen.queryByLabelText("Additional usage before switching")).toBeNull();
    fireEvent.click(screen.getByText("Quota batch"));
    expect(screen.getByLabelText("Additional usage before switching")).toBeTruthy();
  });

  it.each([20, 30, 40])("saves %i with the quota_batch strategy", (percent) => {
    renderSettings();
    fireEvent.click(screen.getByText("Quota batch"));
    fireEvent.input(screen.getByLabelText("Additional usage before switching"), { target: { value: String(percent) } });
    fireEvent.click(screen.getByText("Submit"));
    expect(mock.save).toHaveBeenCalledWith({
      rotation_strategy: "quota_batch",
      quota_batch_percent: percent,
    });
  });

  it.each([0, 101, 30.5])("prevents invalid value %s from being saved", (percent) => {
    renderSettings();
    fireEvent.click(screen.getByText("Quota batch"));
    fireEvent.input(screen.getByLabelText("Additional usage before switching"), { target: { value: String(percent) } });
    const submit = screen.getByText("Submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(mock.save).not.toHaveBeenCalled();
  });
});
