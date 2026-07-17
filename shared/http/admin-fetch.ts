const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REFRESH_WINDOW_MS = 5_000;

interface AdminCsrfToken {
  token: string;
  expiresAt: number;
}

type CsrfResult =
  | { ok: true; value: AdminCsrfToken }
  | { ok: false; response: Response };

let cachedToken: AdminCsrfToken | null = null;

export function clearAdminCsrfCache(): void {
  cachedToken = null;
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input, "http://localhost").pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url, "http://localhost").pathname;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function isAdminCsrfToken(value: unknown): value is AdminCsrfToken {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AdminCsrfToken>;
  return typeof candidate.token === "string"
    && candidate.token.length > 0
    && typeof candidate.expiresAt === "number"
    && Number.isFinite(candidate.expiresAt);
}

function invalidCsrfResponse(): Response {
  return new Response(JSON.stringify({ error: "Invalid CSRF token response" }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

async function getCsrfToken(): Promise<CsrfResult> {
  if (cachedToken && cachedToken.expiresAt - Date.now() >= REFRESH_WINDOW_MS) {
    return { ok: true, value: cachedToken };
  }

  const response = await fetch("/admin/csrf");
  if (!response.ok) return { ok: false, response };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, response: invalidCsrfResponse() };
  }
  if (!isAdminCsrfToken(payload)) {
    return { ok: false, response: invalidCsrfResponse() };
  }
  cachedToken = payload;
  return { ok: true, value: cachedToken };
}

export async function adminFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = requestMethod(input, init);
  if (SAFE_METHODS.has(method) || !requestPath(input).startsWith("/admin/")) {
    return fetch(input, init);
  }

  const csrf = await getCsrfToken();
  if (!csrf.ok) return csrf.response;

  const headers = new Headers(init?.headers);
  headers.set("X-Codex-Proxy-CSRF", csrf.value.token);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 403) clearAdminCsrfCache();
  return response;
}
