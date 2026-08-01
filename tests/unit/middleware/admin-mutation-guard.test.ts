import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mockConfig = {
  server: { proxy_api_key: "test-key" as string | null, trust_proxy: false },
  dashboard: { admin_key: "admin-key" },
  session: { ttl_minutes: 60, cleanup_interval_minutes: 5 },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "192.168.1.100" } }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: (...args: unknown[]) => mockGetConnInfo(...args),
}));

import { dashboardCsrf } from "@src/auth/dashboard-csrf.js";
import { createSession, _resetForTest as resetSessions } from "@src/auth/dashboard-session.js";
import { adminMutationGuard } from "@src/middleware/admin-mutation-guard.js";

function createApp(): Hono {
  const app = new Hono();
  app.use("*", adminMutationGuard);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

function csrfHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Origin: "http://localhost",
    "X-Codex-Proxy-CSRF": token,
    ...extra,
  };
}

describe("admin mutation guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = "test-key";
    mockConfig.server.trust_proxy = false;
    mockGetConnInfo.mockReturnValue({ remote: { address: "192.168.1.100" } });
    resetSessions();
    dashboardCsrf.clear();
  });

  it("passes safe requests and service mutations", async () => {
    const app = createApp();
    expect((await app.request("/admin/settings")).status).toBe(200);
    expect((await app.request("/v1/chat/completions", { method: "POST" })).status).toBe(200);
  });

  it.each([
    "/auth/accounts",
    "/auth/api-keys/import",
    "/api/proxies/import",
    "/admin/backup-resources/accounts",
    "/admin/backup-resources/phones/phone-1/use",
    "/debug/action",
  ])(
    "guards management mutations outside /admin: %s",
    async (path) => {
      expect((await createApp().request(path, { method: "POST" })).status).toBe(403);
    },
  );

  it("allows an exact-origin request with a valid session-bound token", async () => {
    const session = createSession();
    const { token } = dashboardCsrf.issue(`session:${session.id}`);
    const app = createApp();

    const res = await app.request("/admin/settings", {
      method: "POST",
      headers: csrfHeaders(token, { Cookie: `_codex_session=${session.id}` }),
    });

    expect(res.status).toBe(200);
  });

  it.each([undefined, "https://hostile.example", "http://localhost.evil.example"])(
    "rejects a hostile or missing origin: %s",
    async (origin) => {
      const session = createSession();
      const { token } = dashboardCsrf.issue(`session:${session.id}`);
      const headers: Record<string, string> = {
        Cookie: `_codex_session=${session.id}`,
        "X-Codex-Proxy-CSRF": token,
      };
      if (origin) headers.Origin = origin;

      const res = await createApp().request("/admin/settings", {
        method: "POST",
        headers,
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    },
  );

  it.each(["missing", "expired", "mismatched"])("rejects a %s token", async (kind) => {
    let now = 1_000;
    dashboardCsrf.setNowForTest(() => now);
    const session = createSession();
    const otherSession = createSession();
    const { token: validToken } = dashboardCsrf.issue(`session:${session.id}`);
    const { token: mismatchedToken } = dashboardCsrf.issue(`session:${otherSession.id}`);
    if (kind === "expired") now += 15 * 60_000 + 1;

    const headers = csrfHeaders(
      kind === "missing" ? "" : kind === "mismatched" ? mismatchedToken : validToken,
      { Cookie: `_codex_session=${session.id}` },
    );
    if (kind === "missing") delete headers["X-Codex-Proxy-CSRF"];

    const res = await createApp().request("/admin/settings", { method: "POST", headers });
    expect(res.status).toBe(403);
  });

  it("requires a session-bound token for localhost browser mutations", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
    const app = createApp();
    const denied = await app.request("/admin/settings", { method: "POST" });
    expect(denied.status).toBe(403);

    const session = createSession();
    const { token } = dashboardCsrf.issue(`session:${session.id}`);
    const allowed = await app.request("/admin/settings", {
      method: "POST",
      headers: csrfHeaders(token, { Cookie: `_codex_session=${session.id}` }),
    });
    expect(allowed.status).toBe(200);
  });

  it("allows only the exact dashboard bearer when no cookie header is present", async () => {
    const app = createApp();
    const res = await app.request("/admin/settings", {
      method: "POST",
      headers: { Authorization: "Bearer admin-key" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects the service bearer on management mutations", async () => {
    const res = await createApp().request("/admin/settings", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
    });
    expect(res.status).toBe(403);
  });

  it.each(["Bearer wrong", "bearer test-key", "Bearer  test-key"])(
    "rejects a non-exact bearer without bypass: %s",
    async (authorization) => {
      const res = await createApp().request("/admin/settings", {
        method: "POST",
        headers: { Authorization: authorization },
      });
      expect(res.status).toBe(403);
    },
  );

  it("does not let a bearer bypass CSRF when a cookie is present", async () => {
    const session = createSession();
    const res = await createApp().request("/admin/settings", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        Cookie: `_codex_session=${session.id}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid cookie instead of falling back to the localhost principal", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
    const { token } = dashboardCsrf.issue("local:127.0.0.1");
    const res = await createApp().request("/admin/settings", {
      method: "POST",
      headers: csrfHeaders(token, { Cookie: "_codex_session=invalid" }),
    });
    expect(res.status).toBe(403);
  });

  it("ignores spoofed forwarded origin headers when trust_proxy is disabled", async () => {
    const session = createSession();
    const { token } = dashboardCsrf.issue(`session:${session.id}`);
    const res = await createApp().request("http://internal.local/admin/settings", {
      method: "POST",
      headers: csrfHeaders(token, {
        Cookie: `_codex_session=${session.id}`,
        Origin: "https://public.example",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "public.example",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("accepts exact public forwarded origin from first comma token when trusted", async () => {
    mockConfig.server.trust_proxy = true;
    const session = createSession();
    const { token } = dashboardCsrf.issue(`session:${session.id}`);
    const res = await createApp().request("http://internal.local/admin/settings", {
      method: "POST",
      headers: csrfHeaders(token, {
        Cookie: `_codex_session=${session.id}`,
        Origin: "https://public.example",
        "X-Forwarded-Proto": "https, http",
        "X-Forwarded-Host": "public.example, internal.local",
      }),
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ["ftp", "public.example"],
    ["https", "not a host"],
  ])("rejects invalid forwarded origin components (%s, %s)", async (proto, host) => {
    mockConfig.server.trust_proxy = true;
    const session = createSession();
    const { token } = dashboardCsrf.issue(`session:${session.id}`);
    const res = await createApp().request("http://internal.local/admin/settings", {
      method: "POST",
      headers: csrfHeaders(token, {
        Cookie: `_codex_session=${session.id}`,
        Origin: "https://public.example",
        "X-Forwarded-Proto": proto,
        "X-Forwarded-Host": host,
      }),
    });
    expect(res.status).toBe(403);
  });
});
