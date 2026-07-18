/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { I18nProvider } from "../../../../shared/i18n/context";

const mockCallRecords = vi.hoisted(() => ({ useCallRecords: vi.fn() }));

vi.mock("../../../../shared/hooks/use-call-records", () => ({
  useCallRecords: mockCallRecords.useCallRecords,
}));

import { CallRecordsPage } from "../CallRecordsPage";

function state(overrides: Record<string, unknown> = {}) {
  return {
    view: "calls",
    setView: vi.fn(),
    filters: {
      from: "", to: "", contextId: "", search: "", sessionId: "", taskId: "", cwd: "", model: "", provider: "", accountId: "",
      protocol: "", stream: "", sort: "completed_at", order: "desc",
    },
    setFilter: vi.fn(),
    resetFilters: vi.fn(),
    drillIntoContext: vi.fn(),
    records: [{
      id: "record-1", completedAt: "2026-07-12T00:00:00.000Z", model: "gpt-5.4",
      provider: "codex", protocol: "responses", stream: true, latencyMs: 1250,
      inputTokens: 1200, outputTokens: 300, sessionId: "session-1", taskId: "task-1",
      cwd: "/workspace/app", requestTruncated: true, responseTruncated: false,
    }],
    contexts: [],
    total: 1,
    page: 0,
    pageSize: 50,
    hasPrev: false,
    hasNext: false,
    prevPage: vi.fn(),
    nextPage: vi.fn(),
    loading: false,
    error: null,
    selected: {
      id: "record-1",
      requestJson: "{\"prompt\":\"hello\"}",
      responseJson: "{\"text\":\"done\"}",
      requestTruncated: true,
      responseTruncated: false,
    },
    selectRecord: vi.fn(),
    state: {
      enabled: true, rowCount: 1, contextCount: 1, databaseBytes: 8192,
      searchMode: "fts5", path: "/data/call-records.sqlite", retentionDays: null,
      maxBodyBytes: 1_048_576,
    },
    refresh: vi.fn(),
    clearRecords: vi.fn(),
    clearing: false,
    ...overrides,
  };
}

function renderPage() {
  return render(<I18nProvider><CallRecordsPage embedded /></I18nProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CallRecordsPage", () => {
  it("renders call metadata, full selected bodies, and truncation warning", () => {
    const selectRecord = vi.fn();
    mockCallRecords.useCallRecords.mockReturnValue(state({ selectRecord }));

    renderPage();

    expect(screen.getByText("gpt-5.4")).toBeTruthy();
    expect(screen.getByText("1,200 / 300")).toBeTruthy();
    expect(screen.getByText(/\"prompt\": \"hello\"/)).toBeTruthy();
    expect(screen.getByText("Captured content was truncated at the configured size limit.")).toBeTruthy();
    fireEvent.click(screen.getByText("gpt-5.4"));
    expect(selectRecord).toHaveBeenCalledWith("record-1");
  });

  it("switches to grouped contexts and forwards server filters", () => {
    const setView = vi.fn();
    const setFilter = vi.fn();
    const drillIntoContext = vi.fn();
    mockCallRecords.useCallRecords.mockReturnValue(state({
      view: "contexts",
      setView,
      setFilter,
      drillIntoContext,
      records: [],
      contexts: [{
        id: "context-1", sessionId: "session-1", taskId: "task-1", cwd: "/workspace/app",
        source: "responses", callCount: 4, inputTokens: 5000, outputTokens: 800,
        lastCompletedAt: "2026-07-12T00:00:00.000Z",
      }],
      selected: null,
    }));

    renderPage();

    expect(screen.getByText("4 calls")).toBeTruthy();
    expect(screen.getByText("/workspace/app")).toBeTruthy();
    fireEvent.click(screen.getByText("/workspace/app"));
    expect(drillIntoContext).toHaveBeenCalledWith("context-1");
    fireEvent.click(screen.getByText("Calls"));
    expect(setView).toHaveBeenCalledWith("calls");
    fireEvent.input(screen.getByPlaceholderText("Search redacted request and response content"), {
      target: { value: "waste" },
    });
    expect(setFilter).toHaveBeenCalledWith("search", "waste");
  });

  it("requires confirmation before clearing local history", () => {
    const clearRecords = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockCallRecords.useCallRecords.mockReturnValue(state({ clearRecords }));

    renderPage();
    fireEvent.click(screen.getByText("Clear records"));

    expect(window.confirm).toHaveBeenCalled();
    expect(clearRecords).toHaveBeenCalledOnce();
  });

  it("collapses long input and output independently", () => {
    mockCallRecords.useCallRecords.mockReturnValue(state({
      selected: {
        id: "record-long",
        requestJson: JSON.stringify({
          input: [{ role: "user", content: [{ type: "input_text", text: "input ".repeat(120) }] }],
        }),
        responseJson: JSON.stringify({ text: "output ".repeat(120) }),
        requestTruncated: false,
        responseTruncated: false,
      },
    }));

    renderPage();

    const input = screen.getByTestId("call-input-text");
    const output = screen.getByTestId("call-output-text");
    expect(input.className).toContain("call-text-collapsed");
    expect(output.className).toContain("call-text-collapsed");

    const expandButtons = screen.getAllByRole("button", { name: "展开全文" });
    expect(expandButtons).toHaveLength(2);
    expect(expandButtons[0].getAttribute("aria-controls")).toBe(input.id);
    expect(expandButtons[1].getAttribute("aria-controls")).toBe(output.id);
    fireEvent.click(expandButtons[0]);

    expect(input.className).not.toContain("call-text-collapsed");
    expect(output.className).toContain("call-text-collapsed");
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(input.className).toContain("call-text-collapsed");
  });

  it("does not show expansion controls for short detail text", () => {
    mockCallRecords.useCallRecords.mockReturnValue(state({
      selected: {
        id: "record-short",
        requestJson: JSON.stringify({
          input: [{ role: "user", content: [{ type: "input_text", text: "short input" }] }],
        }),
        responseJson: JSON.stringify({ text: "short output" }),
        requestTruncated: false,
        responseTruncated: false,
      },
    }));

    renderPage();

    expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
  });
});
