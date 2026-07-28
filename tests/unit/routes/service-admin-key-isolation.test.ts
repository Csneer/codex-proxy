import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mockConfig = {
  server: { proxy_api_key: "service-secret", trust_proxy: false },
  dashboard: { admin_key: "admin-secret" },
  session: { ttl_minutes: 60, cleanup_interval_minutes: 5 },
};

vi.mock("@src/config.js", () => ({ getConfig: () => mockConfig }));
vi.mock("@src/auth/dashboard-session.js", () => ({ validateSession: () => false }));
vi.mock("@src/models/model-store.js", () => ({
  getModelCatalog: () => [{ id: "gpt-test" }],
  getModelInfo: () => undefined,
  getModelStoreDebug: () => ({}),
}));
vi.mock("@src/models/model-fetcher.js", () => ({ triggerImmediateRefresh: vi.fn() }));

import { dashboardAuth } from "@src/middleware/dashboard-auth.js";
import { createModelRoutes } from "@src/routes/models.js";
import type { AccountPool } from "@src/auth/account-pool.js";

describe("service and administration key isolation", () => {
  let accountPool: AccountPool;

  beforeEach(() => {
    accountPool = {
      validateProxyApiKey: (key: string) => key === "service-secret",
    } as AccountPool;
  });

  function createApp(): Hono {
    const app = new Hono();
    app.use("*", dashboardAuth);
    app.route("/", createModelRoutes(undefined, accountPool));
    app.get("/auth/status", (c) => c.json({ ok: true }));
    return app;
  }

  it("accepts only the service key on model discovery", async () => {
    const app = createApp();
    expect((await app.request("/v1/models", {
      headers: { Authorization: "Bearer service-secret" },
    })).status).toBe(200);
    expect((await app.request("/v1/models", {
      headers: { Authorization: "Bearer admin-secret" },
    })).status).toBe(401);
  });

  it("accepts only the administration key on management routes", async () => {
    const app = createApp();
    expect((await app.request("/auth/status", {
      headers: { Authorization: "Bearer service-secret" },
    })).status).toBe(401);
    expect((await app.request("/auth/status", {
      headers: { Authorization: "Bearer admin-secret" },
    })).status).toBe(200);
  });
});
