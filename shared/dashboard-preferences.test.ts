import { describe, expect, it } from "vitest";
import { createDashboardAuthRoutes } from "../src/routes/dashboard-login.js";

describe("dashboard preferences", () => {
  it("prevents browsers from reusing a stale theme preference", async () => {
    const response = await createDashboardAuthRoutes().request("http://localhost/auth/dashboard-preferences");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
