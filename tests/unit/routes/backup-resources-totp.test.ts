import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BackupSecretCipher } from "@src/backup-resources/crypto.js";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { generateTotpCode } from "@src/backup-resources/totp.js";
import { createBackupResourceRoutes } from "@src/routes/admin/backup-resources.js";

const stores: BackupResourceStore[] = [];
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function makeApp() {
  const path = join(mkdtempSync(join(tmpdir(), "backup-totp-routes-")), "backup-resources.sqlite");
  const store = new BackupResourceStore(path, new BackupSecretCipher(randomBytes(32)));
  stores.push(store);
  return createBackupResourceRoutes(() => store);
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

describe("backup resource TOTP route", () => {
  it("returns a no-store current code for an account with a TOTP secret", async () => {
    const now = new Date("2026-09-04T00:00:00.000Z");
    vi.useFakeTimers({ now });
    const app = makeApp();
    const created = await (await app.request("/admin/backup-resources/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "totp@example.com", totpSecret: RFC_SECRET }),
    })).json() as { id: string };

    const response = await app.request(`/admin/backup-resources/accounts/${created.id}/totp`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual(generateTotpCode(RFC_SECRET, now.getTime()));
    expect(JSON.stringify(body)).not.toContain(RFC_SECRET);
  });

  it("returns explicit errors for missing and malformed TOTP secrets", async () => {
    const app = makeApp();
    const empty = await (await app.request("/admin/backup-resources/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "empty@example.com" }),
    })).json() as { id: string };
    const invalid = await (await app.request("/admin/backup-resources/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "invalid@example.com", totpSecret: "not valid!" }),
    })).json() as { id: string };

    const emptyResponse = await app.request(`/admin/backup-resources/accounts/${empty.id}/totp`);
    expect(emptyResponse.status).toBe(404);
    expect(emptyResponse.headers.get("cache-control")).toBe("no-store");
    expect(await emptyResponse.json()).toEqual({ error: "totp_not_set" });

    const invalidResponse = await app.request(`/admin/backup-resources/accounts/${invalid.id}/totp`);
    expect(invalidResponse.status).toBe(422);
    expect(invalidResponse.headers.get("cache-control")).toBe("no-store");
    expect(await invalidResponse.json()).toEqual({ error: "invalid_totp_secret" });
  });
});
