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
      body: JSON.stringify({ email: "user@example.com", accountStatus: "plus", emailPassword: "secret", totpSecret: "123456" }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created).toMatchObject({ email: "user@example.com", accountStatus: "plus", hasEmailPassword: true, hasTotpSecret: true });
    expect(created).not.toHaveProperty("emailPassword");

    const list = await (await app.request("/admin/backup-resources/accounts")).json();
    expect(list).toEqual([{ ...created, promotion: null }]);
    expect(JSON.stringify(list)).not.toContain("secret");

    const detailResponse = await app.request(`/admin/backup-resources/accounts/${created.id}`);
    expect(detailResponse.headers.get("cache-control")).toBe("no-store");
    expect(await detailResponse.json()).toMatchObject({ emailPassword: "secret", totpSecret: "123456" });

    const patchResponse = await app.request(`/admin/backup-resources/accounts/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "changed@example.com", accountStatus: "pro", totpSecret: null }),
    });
    expect(await patchResponse.json()).toMatchObject({
      email: "changed@example.com",
      accountStatus: "pro",
      hasEmailPassword: true,
      hasTotpSecret: false,
    });
  });

  it("lists safe account-factory metadata without factory secrets", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "backup-routes-")), "backup-resources.sqlite");
    const store = new BackupResourceStore(path, new BackupSecretCipher(randomBytes(32)));
    stores.push(store);
    const app = createBackupResourceRoutes(() => store);
    store.syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: "mailbox-1",
      email: "dashboard@example.com",
      sourceRevision: "rev-1",
      active: true,
    });

    const list = await (await app.request("/admin/backup-resources/accounts")).json() as Array<Record<string, unknown>>;

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      email: "dashboard@example.com",
      lifecycleStatus: "available",
      sourceSystem: "mail_dashboard",
      sourceActive: true,
      revision: 1,
      lastMailSyncedAt: expect.any(String),
    });
    for (const forbidden of ["emailPassword", "chatgptPassword", "totpSecret", "emailCodeUrl", "accessToken", "refreshToken", "sessionJson", "progress", "lastErrorCode"]) {
      expect(list[0]).not.toHaveProperty(forbidden);
    }
  });

  it("rejects unsupported account statuses", async () => {
    const app = makeApp();
    const response = await app.request("/admin/backup-resources/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", accountStatus: "enterprise" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
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
