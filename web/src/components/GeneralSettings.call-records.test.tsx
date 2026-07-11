/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { I18nProvider } from "../../../shared/i18n/context";

const mockSettings = vi.hoisted(() => ({ useSettings: vi.fn(() => ({ apiKey: null })) }));
const mockGeneral = vi.hoisted(() => ({ useGeneralSettings: vi.fn() }));

vi.mock("../../../shared/hooks/use-settings", () => mockSettings);
vi.mock("../../../shared/hooks/use-general-settings", () => mockGeneral);

import { GeneralSettings } from "./GeneralSettings";

afterEach(cleanup);

describe("GeneralSettings call recording controls", () => {
  it("saves opt-in, retention, and capture size together", async () => {
    const save = vi.fn(async () => undefined);
    mockGeneral.useGeneralSettings.mockReturnValue({
      data: {
        call_records_enabled: false,
        call_records_retention_days: null,
        call_records_max_body_bytes: 1_048_576,
      },
      saving: false, saved: false, error: null, restartRequired: false, save,
    });
    render(<I18nProvider><GeneralSettings /></I18nProvider>);

    fireEvent.click(screen.getByText("General Settings"));
    fireEvent.click(screen.getByLabelText("Store successful call bodies"));
    fireEvent.input(screen.getByLabelText("Call record retention"), { target: { value: "30" } });
    fireEvent.input(screen.getByLabelText("Maximum body bytes"), { target: { value: "262144" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(save).toHaveBeenCalledWith({
      call_records_enabled: true,
      call_records_retention_days: 30,
      call_records_max_body_bytes: 262_144,
    });
    expect(screen.getByText(/stored locally after redaction/i)).toBeTruthy();
  });
});
