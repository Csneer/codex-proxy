import type { Context, Next } from "hono";
import { getConfig } from "../config.js";
import {
  dashboardCsrf,
  localDashboardPrincipal,
  sessionDashboardPrincipal,
} from "../auth/dashboard-csrf.js";
import { validateSession } from "../auth/dashboard-session.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { isLocalhostRequest } from "../utils/is-localhost.js";
import { parseSessionCookie } from "../utils/parse-cookie.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function forbidden(c: Context, error: string): Response {
  c.status(403);
  return c.json({ error });
}

export async function adminMutationGuard(c: Context, next: Next): Promise<Response | void> {
  const path = c.req.path;
  if (SAFE_METHODS.has(c.req.method) || (path !== "/admin" && !path.startsWith("/admin/"))) {
    return next();
  }

  const config = getConfig();
  const cookieHeader = c.req.header("cookie");
  let principal: string | undefined;

  if (cookieHeader !== undefined) {
    const sessionId = parseSessionCookie(cookieHeader);
    if (!sessionId || !validateSession(sessionId)) {
      return forbidden(c, "Valid dashboard session required");
    }
    principal = sessionDashboardPrincipal(sessionId);
  } else {
    const expectedBearer = config.server.proxy_api_key
      ? `Bearer ${config.server.proxy_api_key}`
      : undefined;
    if (expectedBearer && c.req.header("authorization") === expectedBearer) {
      return next();
    }

    const remoteAddr = getRealClientIp(c, config.server.trust_proxy);
    if (isLocalhostRequest(remoteAddr)) {
      principal = localDashboardPrincipal(remoteAddr);
    }
  }

  if (!principal) {
    return forbidden(c, "CSRF-protected dashboard principal required");
  }

  const origin = c.req.header("origin");
  if (!origin || origin !== new URL(c.req.url).origin) {
    return forbidden(c, "Request origin does not match dashboard origin");
  }

  const token = c.req.header("x-codex-proxy-csrf");
  if (!token || !dashboardCsrf.verify(principal, token)) {
    return forbidden(c, "Valid CSRF token required");
  }

  return next();
}
