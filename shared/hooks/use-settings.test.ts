import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
}));

const mocks = vi.hoisted(() => ({
  adminFetch: vi.fn(),
  notifyDashboardAuthExpired: vi.fn(),
}));

vi.mock("../http/admin-fetch.js", () => ({ adminFetch: mocks.adminFetch }));
vi.mock("./use-dashboard-auth.js", () => ({
  notifyDashboardAuthExpired: mocks.notifyDashboardAuthExpired,
}));

import { useSettings } from "./use-settings.js";

describe("useSettings credential boundaries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("updates the service key through the browser management session without a Bearer header", async () => {
    mocks.adminFetch.mockResolvedValue(new Response(JSON.stringify({ proxy_api_key: "next-service-key" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const { saveServiceKey } = useSettings();
    await saveServiceKey("next-service-key");

    expect(mocks.adminFetch).toHaveBeenCalledWith("/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxy_api_key: "next-service-key" }),
    });
  });

  it("rotates the admin key without exposing it as a Bearer token and expires the current session", async () => {
    mocks.adminFetch.mockResolvedValue(new Response(JSON.stringify({
      admin_key_configured: true,
      reauth_required: true,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const { rotateAdminKey } = useSettings();
    await rotateAdminKey("next-admin-key");

    expect(mocks.adminFetch).toHaveBeenCalledWith("/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_key: "next-admin-key" }),
    });
    expect(mocks.notifyDashboardAuthExpired).toHaveBeenCalledOnce();
  });
});
