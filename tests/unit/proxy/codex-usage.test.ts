import { describe, expect, it, vi } from "vitest";
import { fetchUsage } from "@src/proxy/codex-usage.js";
import { CodexApiError } from "@src/proxy/codex-types.js";
import type { TlsTransport } from "@src/tls/transport.js";

function transport(status: number, body: string, headers = new Headers()): TlsTransport {
  return {
    isImpersonate: () => false,
    get: vi.fn(async () => ({ status, body, headers, setCookieHeaders: [] })),
  } as unknown as TlsTransport;
}

describe("fetchUsage HTTP errors", () => {
  it.each([401, 402, 403])("preserves upstream HTTP %i status and body", async (status) => {
    const body = JSON.stringify({ error: { message: `upstream ${status}` } });
    let caught: unknown;
    try {
      await fetchUsage({}, null, "https://chatgpt.com/backend-api", transport(status, body));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodexApiError);
    expect((caught as CodexApiError).status).toBe(status);
    expect((caught as CodexApiError).body).toBe(body);
  });

  it("continues to the fallback usage URL after a missing endpoint", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 404, body: "not found", headers: new Headers(), setCookieHeaders: [] })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          plan_type: "plus",
          rate_limit: { allowed: true, limit_reached: false, primary_window: null, secondary_window: null },
        }),
        headers: new Headers(),
        setCookieHeaders: [],
      });
    const result = await fetchUsage({}, null, "https://chatgpt.com/backend-api", {
      isImpersonate: () => false,
      get,
    } as unknown as TlsTransport);
    expect(result.plan_type).toBe("plus");
    expect(get).toHaveBeenCalledTimes(2);
  });
});
