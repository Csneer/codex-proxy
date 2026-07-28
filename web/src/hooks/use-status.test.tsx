/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStatus } from "../../../shared/hooks/use-status";

const catalog = [{
  id: "gpt-test",
  displayName: "GPT Test",
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
  defaultReasoningEffort: "medium",
  outputModalities: ["text"],
}];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useStatus model polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the resolved service key for later model refreshes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/auth/status") return jsonResponse({ authenticated: true, proxy_api_key: "service-key" });
      if (path === "/v1/models/catalog") return jsonResponse(catalog);
      if (path === "/v1/models") return jsonResponse({ data: [{ id: "gpt-test" }] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useStatus(1));
    await waitFor(() => expect(result.current.models).toEqual(["gpt-test"]));

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    const modelCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/v1/models"));
    expect(modelCalls).toHaveLength(4);
    for (const [, init] of modelCalls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer service-key");
    }
  });

  it("does not replace model arrays with an error response", async () => {
    let modelRound = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/auth/status") return jsonResponse({ authenticated: true, proxy_api_key: "service-key" });
      if (path === "/v1/models/catalog") {
        modelRound += 1;
        return modelRound === 1 ? jsonResponse(catalog) : jsonResponse({ error: "Unauthorized" }, 401);
      }
      if (path === "/v1/models") {
        return modelRound === 1
          ? jsonResponse({ data: [{ id: "gpt-test" }] })
          : jsonResponse({ error: "Unauthorized" }, 401);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useStatus(1));
    await waitFor(() => expect(result.current.models).toEqual(["gpt-test"]));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(result.current.models).toEqual(["gpt-test"]);
    expect(result.current.modelCatalog).toEqual(catalog);
  });
});
