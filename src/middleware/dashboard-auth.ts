/**
 * Dashboard Auth Middleware — cookie-based login gate for the web dashboard.
 *
 * Management requests always require an independent Dashboard credential or session.
 * Public, service, and independently-authenticated routes are classified explicitly.
 */

import type { Context, Next } from "hono";
import { getConfig } from "../config.js";
import { validateSession } from "../auth/dashboard-session.js";
import { parseSessionCookie } from "../utils/parse-cookie.js";
import { classifyRequestPath } from "../auth/route-auth-policy.js";

/** Detect HTTPS from X-Forwarded-Proto or protocol. */
function isHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.toLowerCase() === "https";
  const url = new URL(c.req.url);
  return url.protocol === "https:";
}

export async function dashboardAuth(c: Context, next: Next): Promise<Response | void> {
  const config = getConfig();
  const surface = classifyRequestPath(c.req.path, c.req.method);

  if (surface !== "management") return next();

  // Dashboard automation uses the administration key, never a service key.
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token === config.dashboard.admin_key) return next();

  // Check session cookie
  const sessionId = parseSessionCookie(c.req.header("cookie"));
  if (sessionId && validateSession(sessionId)) {
    // Sliding window: refresh cookie Max-Age to stay in sync with server-side renewal
    const maxAge = config.session.ttl_minutes * 60;
    const secure = isHttps(c);
    let cookie = `_codex_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
    if (secure) cookie += "; Secure";
    c.header("Set-Cookie", cookie);
    return next();
  }

  // Not authenticated — reject
  c.status(401);
  return c.json({ error: "Dashboard login required" });
}
