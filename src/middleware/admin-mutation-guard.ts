import type { Context, Next } from "hono";
import { getConfig } from "../config.js";
import {
  dashboardCsrf,
  sessionDashboardPrincipal,
} from "../auth/dashboard-csrf.js";
import { validateSession } from "../auth/dashboard-session.js";
import { parseSessionCookie } from "../utils/parse-cookie.js";
import { classifyRequestPath } from "../auth/route-auth-policy.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function forbidden(c: Context, error: string): Response {
  c.status(403);
  return c.json({ error });
}

function expectedOrigin(c: Context, trustProxy: boolean): string | null {
  const fallback = new URL(c.req.url).origin;
  if (!trustProxy) return fallback;
  const protoHeader = c.req.header("x-forwarded-proto");
  const hostHeader = c.req.header("x-forwarded-host");
  if (!protoHeader || !hostHeader) return fallback;
  const proto = protoHeader.split(",", 1)[0]?.trim().toLowerCase();
  const host = hostHeader.split(",", 1)[0]?.trim();
  if ((proto !== "http" && proto !== "https") || !host) return null;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

export async function adminMutationGuard(c: Context, next: Next): Promise<Response | void> {
  const path = c.req.path;
  if (SAFE_METHODS.has(c.req.method) || classifyRequestPath(path, c.req.method) !== "management") {
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
    const expectedBearer = `Bearer ${config.dashboard.admin_key}`;
    if (c.req.header("authorization") === expectedBearer) {
      return next();
    }
  }

  if (!principal) {
    return forbidden(c, "CSRF-protected dashboard principal required");
  }

  const origin = c.req.header("origin");
  const requestOrigin = expectedOrigin(c, config.server.trust_proxy);
  if (!requestOrigin || !origin || origin !== requestOrigin) {
    return forbidden(c, "Request origin does not match dashboard origin");
  }

  const token = c.req.header("x-codex-proxy-csrf");
  if (!token || !dashboardCsrf.verify(principal, token)) {
    return forbidden(c, "Valid CSRF token required");
  }

  return next();
}
