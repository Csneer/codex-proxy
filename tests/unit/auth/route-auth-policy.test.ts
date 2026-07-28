import { describe, expect, it } from "vitest";
import { classifyRequestPath } from "@src/auth/route-auth-policy.js";

describe("route authentication policy", () => {
  it.each([
    ["GET", "/", "public"],
    ["GET", "/assets/app.js", "public"],
    ["GET", "/health", "public"],
    ["POST", "/auth/dashboard-login", "public"],
    ["GET", "/auth/dashboard-status", "public"],
    ["GET", "/auth/callback", "public"],
    ["GET", "/admin/ui-background", "public"],
    ["GET", "/v1/models", "service"],
    ["POST", "/v1beta/models/model:generateContent", "service"],
    ["POST", "/responses", "service"],
    ["POST", "/responses/review", "service"],
    ["GET", "/official-agent/apps", "independent"],
    ["GET", "/auth/accounts/export", "management"],
    ["POST", "/auth/login-start", "management"],
    ["POST", "/api/proxies/import", "management"],
    ["GET", "/debug/models", "management"],
    ["GET", "/future-route", "management"],
  ] as const)("classifies %s %s as %s", (method, path, expected) => {
    expect(classifyRequestPath(path, method)).toBe(expected);
  });

  it("keeps mutations on GET-only public paths in the management surface", () => {
    expect(classifyRequestPath("/admin/ui-background", "POST")).toBe("management");
  });
});
