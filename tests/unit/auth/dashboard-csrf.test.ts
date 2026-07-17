import { describe, expect, it } from "vitest";
import { createDashboardCsrfStore } from "@src/auth/dashboard-csrf.js";

describe("dashboard CSRF store", () => {
  it("issues a fresh 32-byte base64url token and keeps one token per principal", () => {
    const store = createDashboardCsrfStore({ now: () => 10_000 });

    const first = store.issue("session:first");
    const replacement = store.issue("session:first");
    const other = store.issue("session:other");

    expect(first).toMatchObject({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: 910_000 });
    expect(replacement.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(other.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replacement.token).not.toBe(first.token);
    expect(other.token).not.toBe(replacement.token);
    expect(store.verify("session:first", first.token)).toBe(false);
    expect(store.verify("session:first", replacement.token)).toBe(true);
    expect(store.verify("session:other", replacement.token)).toBe(false);
  });

  it("expires tokens using injectable time and the default fifteen-minute TTL", () => {
    let now = 10_000;
    const store = createDashboardCsrfStore({ now: () => now });
    const token = store.issue("local:127.0.0.1");

    now += 15 * 60_000;
    expect(token.expiresAt).toBe(910_000);
    expect(store.verify("local:127.0.0.1", token.token)).toBe(true);
    now += 1;
    expect(store.verify("local:127.0.0.1", token.token)).toBe(false);
  });

  it("supports an injected TTL and revokes the principal token", () => {
    let now = 1_000;
    const store = createDashboardCsrfStore({ now: () => now, ttlMs: 25 });
    const token = store.issue("session:abc");

    now += 24;
    expect(token.expiresAt).toBe(1_025);
    expect(store.verify("session:abc", token.token)).toBe(true);
    store.revoke("session:abc");
    expect(store.verify("session:abc", token.token)).toBe(false);
  });

  it("can clear state while retaining injected test time control", () => {
    let now = 100;
    const store = createDashboardCsrfStore({ now: () => now, ttlMs: 10 });
    const first = store.issue("session:test");
    store.clear();
    expect(store.verify("session:test", first.token)).toBe(false);

    now = 500;
    const second = store.issue("session:test");
    now = 511;
    expect(store.verify("session:test", second.token)).toBe(false);
  });
});
