import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAccountFactoryAuth } from "@src/middleware/account-factory-auth.js";
import type { AppConfig } from "@src/config-schema.js";

function config(overrides: Partial<AppConfig["account_factory"]> = {}): AppConfig {
  return {
    account_factory: {
      enabled: true,
      token: "test-factory-token",
      allowed_extension_ids: ["allowed-extension"],
      mail_dashboard_base_url: "http://127.0.0.1:4173",
      ...overrides,
    },
  } as AppConfig;
}

function app(options: {
  config?: Partial<AppConfig["account_factory"]>;
  local?: boolean;
} = {}) {
  const router = new Hono();
  router.use(
    "/integration/account-factory/v1/*",
    createAccountFactoryAuth(
      () => config(options.config),
      () => options.local ?? true,
    ),
  );
  router.get("/integration/account-factory/v1/health", (c) => c.json({ ok: true }));
  return router;
}

describe("account-factory auth", () => {
  it("keeps the integration default-off", async () => {
    const response = await app({ config: { enabled: false } }).request(
      "/integration/account-factory/v1/health",
      { headers: { "x-account-factory-token": "test-factory-token" } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "feature_disabled" });
  });

  it("requires a loopback request before checking the integration token", async () => {
    const response = await app({ local: false }).request(
      "/integration/account-factory/v1/health",
      { headers: { "x-account-factory-token": "test-factory-token" } },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "loopback_required" });
  });

  it("rejects an unapproved extension origin", async () => {
    const response = await app().request("/integration/account-factory/v1/health", {
      headers: {
        origin: "chrome-extension://unapproved-extension",
        "x-account-factory-token": "test-factory-token",
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
  });

  it("requires the configured scoped token", async () => {
    const router = app();
    const missing = await router.request("/integration/account-factory/v1/health");
    const wrong = await router.request("/integration/account-factory/v1/health", {
      headers: { "x-account-factory-token": "wrong-token" },
    });
    const unconfigured = await app({ config: { token: null } }).request(
      "/integration/account-factory/v1/health",
      { headers: { "x-account-factory-token": "test-factory-token" } },
    );

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });
    expect(unconfigured.status).toBe(401);
    expect(await unconfigured.json()).toEqual({ error: "unauthorized" });
  });

  it("allows loopback requests without an Origin when the scoped token is present", async () => {
    const response = await app().request("/integration/account-factory/v1/health", {
      headers: { "x-account-factory-token": "test-factory-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("allows loopback requests from an approved extension origin with the scoped token", async () => {
    const response = await app().request("/integration/account-factory/v1/health", {
      headers: {
        origin: "chrome-extension://allowed-extension",
        "x-account-factory-token": "test-factory-token",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("supports a local-only wildcard for personal unpacked extension ids", async () => {
    const response = await app({ config: { allowed_extension_ids: ["*"] } }).request(
      "/integration/account-factory/v1/health",
      {
        headers: {
          origin: "chrome-extension://changing-unpacked-id",
          "x-account-factory-token": "test-factory-token",
        },
      },
    );

    expect(response.status).toBe(200);
  });
});
