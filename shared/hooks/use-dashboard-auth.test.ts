import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => effect(),
  useCallback: (callback: unknown) => callback,
}));

const { clearAdminCsrfCache } = vi.hoisted(() => ({ clearAdminCsrfCache: vi.fn() }));
vi.mock("../http/admin-fetch.js", () => ({ clearAdminCsrfCache }));

import { useDashboardAuth } from "./use-dashboard-auth.js";

describe("useDashboardAuth CSRF cache lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("clears cached CSRF credentials after login, logout, and auth expiry", async () => {
    const windowTarget = new EventTarget() as EventTarget & {
      fetch: ReturnType<typeof vi.fn>;
    };
    windowTarget.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/auth/dashboard-status") {
        return new Response(JSON.stringify({ required: true, authenticated: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => windowTarget.fetch(...args));

    const { login, logout } = useDashboardAuth();
    await vi.waitFor(() => expect(clearAdminCsrfCache).toHaveBeenCalledOnce());
    clearAdminCsrfCache.mockClear();

    await login("secret-key");
    expect(clearAdminCsrfCache).toHaveBeenCalledTimes(1);

    await logout();
    expect(clearAdminCsrfCache).toHaveBeenCalledTimes(2);

    windowTarget.dispatchEvent(new Event("codex:auth-expired"));
    expect(clearAdminCsrfCache).toHaveBeenCalledTimes(3);
  });
});
