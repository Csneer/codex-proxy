/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCallRecords } from "../../../shared/hooks/use-call-records";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useCallRecords search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/admin/call-records/state") {
        return jsonResponse({ enabled: true, rowCount: 0, contextCount: 0, databaseBytes: 0 });
      }
      return jsonResponse({ records: [], total: 0, limit: 50, offset: 0 });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("issues one query after rapid search input settles", async () => {
    const listCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/admin/call-records?"));
    const { result } = renderHook(() => useCallRecords());
    await act(async () => { await vi.runAllTimersAsync(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.nextPage());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.page).toBe(1);
    vi.mocked(fetch).mockClear();

    act(() => {
      result.current.setFilter("search", "t");
      result.current.setFilter("search", "to");
      result.current.setFilter("search", "token");
    });

    expect(listCalls()).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(listCalls()).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(listCalls()).toHaveLength(1);
    expect(String(listCalls()[0][0])).toContain("search=token");
  });
});
