import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cors } from "@src/middleware/cors.js";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

vi.mock("@src/config.js", () => ({ getConfig: mocks.getConfig }));

function createApp() {
  const app = new Hono();
  app.use("*", cors);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  mocks.getConfig.mockReturnValue({
    server: { cors: [] },
    account_factory: { enabled: true, allowed_extension_ids: ["allowed-extension"] },
  });
});

describe("account-factory CORS", () => {
  it("allows the configured extension origin and only the scoped preflight headers", async () => {
    const response = await createApp().request("/integration/account-factory/v1/claims", {
      method: "OPTIONS",
      headers: {
        Origin: "chrome-extension://allowed-extension",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, X-Account-Factory-Token",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://allowed-extension");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,PATCH,OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Account-Factory-Token");
  });

  it("rejects loopback and unconfigured extension origins for factory preflight", async () => {
    const app = createApp();
    const loopback = await app.request("/integration/account-factory/v1/claims", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST" },
    });
    const unconfigured = await app.request("/integration/account-factory/v1/claims", {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://other-extension", "Access-Control-Request-Method": "POST" },
    });

    expect(loopback.status).toBe(403);
    expect(unconfigured.status).toBe(403);
  });
});
