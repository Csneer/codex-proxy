import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BackupSecretCipher } from "@src/backup-resources/crypto.js";
import { BackupResourceStore } from "@src/backup-resources/store.js";
import { createBackupResourceRoutes } from "@src/routes/admin/backup-resources.js";

const stores: BackupResourceStore[] = [];

function makeApp() {
  const path = join(mkdtempSync(join(tmpdir(), "backup-routes-")), "backup-resources.sqlite");
  const store = new BackupResourceStore(path, new BackupSecretCipher(randomBytes(32)));
  stores.push(store);
  return createBackupResourceRoutes(() => store);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("backup resource admin routes", () => {
  it("provides account CRUD without exposing list secrets", async () => {
    const app = makeApp();
    const createResponse = await app.request("/admin/backup-resources/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", emailPassword: "secret", totpSecret: "123456" }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created).toMatchObject({ email: "user@example.com", hasEmailPassword: true, hasTotpSecret: true });
    expect(created).not.toHaveProperty("emailPassword");

    const list = await (await app.request("/admin/backup-resources/accounts")).json();
    expect(list).toEqual([created]);
    expect(JSON.stringify(list)).not.toContain("secret");

    const detailResponse = await app.request(`/admin/backup-resources/accounts/${created.id}`);
    expect(detailResponse.headers.get("cache-control")).toBe("no-store");
    expect(await detailResponse.json()).toMatchObject({ emailPassword: "secret", totpSecret: "123456" });

    const patchResponse = await app.request(`/admin/backup-resources/accounts/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "changed@example.com", totpSecret: null }),
    });
    expect(await patchResponse.json()).toMatchObject({
      email: "changed@example.com",
      hasEmailPassword: true,
      hasTotpSecret: false,
    });
  });

  it("validates bodies, handles phone use, and returns sanitized failures", async () => {
    const app = makeApp();
    const invalid = await app.request("/admin/backup-resources/phones", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "", useCount: -1 }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_request" });

    const createdResponse = await app.request("/admin/backup-resources/phones", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "+15555550123", note: null }),
    });
    const created = await createdResponse.json();
    expect(created).toMatchObject({ phoneNumber: "+15555550123", note: "" });
    const used = await app.request(`/admin/backup-resources/phones/${created.id}/use`, { method: "POST" });
    expect(await used.json()).toMatchObject({ useCount: 1 });

    const failing = createBackupResourceRoutes(() => { throw new Error("secret database detail"); });
    const failure = await failing.request("/admin/backup-resources/accounts");
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ error: "backup_resources_unavailable" });
  });
});
