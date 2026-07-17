import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch, clearAdminCsrfCache } from "./admin-fetch.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("adminFetch", () => {
  beforeEach(() => {
    clearAdminCsrfCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("delegates a safe %s directly", async (method) => {
    const response = new Response(null, { status: 204 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const init = { method, headers: { "X-Caller": "kept" } };

    await expect(adminFetch("/admin/settings", init)).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/admin/settings", init);
  });

  it("fetches and caches a token before an admin mutation while preserving request init", async () => {
    const expiresAt = Date.now() + 60_000;
    const mutationResponse = jsonResponse({ ok: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "csrf-token", expiresAt }))
      .mockResolvedValueOnce(mutationResponse);
    vi.stubGlobal("fetch", fetchMock);
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller": "kept" },
      body: JSON.stringify({ enabled: true }),
      credentials: "include" as RequestCredentials,
      signal: new AbortController().signal,
    };

    await expect(adminFetch("/admin/settings", init)).resolves.toBe(mutationResponse);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/admin/csrf");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/admin/settings", {
      ...init,
      headers: expect.any(Headers),
    });
    const sentInit = fetchMock.mock.calls[1][1] as RequestInit;
    const sentHeaders = sentInit.headers as Headers;
    expect(sentHeaders.get("Content-Type")).toBe("application/json");
    expect(sentHeaders.get("X-Caller")).toBe("kept");
    expect(sentHeaders.get("X-Codex-Proxy-CSRF")).toBe("csrf-token");
    expect(sentInit.body).toBe(init.body);
    expect(sentInit.credentials).toBe("include");
    expect(sentInit.signal).toBe(init.signal);
  });

  it("preserves a Request body's method and headers while merging init headers", async () => {
    const expiresAt = Date.now() + 60_000;
    const original = new Request("http://localhost/admin/settings", {
      method: "POST",
      headers: {
        Authorization: "Bearer request-token",
        "Content-Type": "application/json",
        "X-Custom": "from-request",
      },
      body: JSON.stringify({ enabled: true }),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "csrf-token", expiresAt }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(adminFetch(original, {
      headers: {
        "X-Custom": "from-init",
        "X-Init": "kept",
      },
    })).resolves.toMatchObject({ status: 200 });

    const [outgoingInput, outgoingInit] = fetchMock.mock.calls[1] as [RequestInfo, RequestInit | undefined];
    expect(outgoingInput).toBeInstanceOf(Request);
    const outgoing = outgoingInput as Request;
    expect(outgoingInit).toBeUndefined();
    expect(outgoing.method).toBe("POST");
    expect(outgoing.headers.get("Authorization")).toBe("Bearer request-token");
    expect(outgoing.headers.get("Content-Type")).toBe("application/json");
    expect(outgoing.headers.get("X-Custom")).toBe("from-init");
    expect(outgoing.headers.get("X-Init")).toBe("kept");
    expect(outgoing.headers.get("X-Codex-Proxy-CSRF")).toBe("csrf-token");
    await expect(outgoing.json()).resolves.toEqual({ enabled: true });
    expect(original.bodyUsed).toBe(false);
  });

  it("deduplicates concurrent token fetches and shares the token across mutations", async () => {
    const expiresAt = Date.now() + 60_000;
    let resolveToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => { resolveToken = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(tokenResponse)
      .mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const first = adminFetch("/admin/one", { method: "POST" });
    const second = adminFetch("/admin/two", { method: "POST" });
    resolveToken(jsonResponse({ token: "shared-token", expiresAt }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(fetchMock.mock.calls.filter(([input]) => input === "/admin/csrf")).toHaveLength(1);
    for (const call of fetchMock.mock.calls.slice(1)) {
      const headers = (call[1] as RequestInit).headers as Headers;
      expect(headers.get("X-Codex-Proxy-CSRF")).toBe("shared-token");
    }
  });

  it("does not let a cleared in-flight token repopulate the cache", async () => {
    const expiresAt = Date.now() + 60_000;
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const firstToken = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondToken = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstToken)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockReturnValueOnce(secondToken)
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = adminFetch("/admin/one", { method: "POST" });
    clearAdminCsrfCache();
    resolveFirst(jsonResponse({ token: "stale-token", expiresAt }));
    await pending;

    const next = adminFetch("/admin/two", { method: "POST" });
    resolveSecond(jsonResponse({ token: "fresh-token", expiresAt }));
    await next;

    expect(fetchMock.mock.calls.filter(([input]) => input === "/admin/csrf")).toHaveLength(2);
    const nextHeaders = fetchMock.mock.calls[3][1]!.headers as Headers;
    expect(nextHeaders.get("X-Codex-Proxy-CSRF")).toBe("fresh-token");
  });

  it("reuses the cached token at the five-second refresh boundary", async () => {
    const expiresAt = Date.now() + 10_000;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "cached", expiresAt }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await adminFetch("/admin/settings", { method: "POST" });
    vi.advanceTimersByTime(5_000);
    await adminFetch("/admin/settings", { method: "POST" });

    expect(fetchMock.mock.calls.filter(([input]) => input === "/admin/csrf")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes the cached token when less than five seconds remain", async () => {
    const firstExpiry = Date.now() + 10_000;
    const secondExpiry = Date.now() + 60_000;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "first", expiresAt: firstExpiry }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ token: "second", expiresAt: secondExpiry }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await adminFetch("/admin/settings", { method: "POST" });
    vi.advanceTimersByTime(5_001);
    await adminFetch("/admin/settings", { method: "POST" });

    expect(fetchMock.mock.calls.filter(([input]) => input === "/admin/csrf")).toHaveLength(2);
    const refreshedHeaders = fetchMock.mock.calls[3][1]!.headers as Headers;
    expect(refreshedHeaders.get("X-Codex-Proxy-CSRF")).toBe("second");
  });

  it("clears the cache after a mutation 403 so the next mutation refetches", async () => {
    const expiresAt = Date.now() + 60_000;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "first", expiresAt }))
      .mockResolvedValueOnce(jsonResponse({ error: "denied" }, { status: 403 }))
      .mockResolvedValueOnce(jsonResponse({ token: "second", expiresAt }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await adminFetch("/admin/settings", { method: "POST" })).status).toBe(403);
    expect((await adminFetch("/admin/settings", { method: "POST" })).status).toBe(200);
    expect(fetchMock.mock.calls.filter(([input]) => input === "/admin/csrf")).toHaveLength(2);
  });

  it("clearAdminCsrfCache forces the next mutation to refetch", async () => {
    const expiresAt = Date.now() + 60_000;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "first", expiresAt }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ token: "second", expiresAt }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await adminFetch("/admin/settings", { method: "POST" });
    clearAdminCsrfCache();
    await adminFetch("/admin/settings", { method: "POST" });
    expect(fetchMock.mock.calls.filter(([input]) => input === "/admin/csrf")).toHaveLength(2);
  });

  it("returns a failed token response without sending the mutation", async () => {
    const tokenFailure = jsonResponse({ error: "login required" }, { status: 403 });
    const fetchMock = vi.fn().mockResolvedValue(tokenFailure);
    vi.stubGlobal("fetch", fetchMock);

    await expect(adminFetch("/admin/settings", { method: "POST" })).resolves.toBe(tokenFailure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/admin/csrf");
  });

  it("returns a controlled failure for malformed token JSON without sending the mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: "", expiresAt: "later" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await adminFetch("/admin/settings", { method: "POST" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Invalid CSRF token response" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/admin/csrf");
  });

  it("returns a controlled failure for invalid token JSON without sending the mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await adminFetch("/admin/settings", { method: "POST" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Invalid CSRF token response" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
