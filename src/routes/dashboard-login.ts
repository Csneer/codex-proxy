/**
 * Dashboard Login Routes — cookie-based authentication for the web dashboard.
 *
 * Provides login/logout/status endpoints that work with the dashboard-auth middleware.
 * Uses the independent dashboard.admin_key as the dashboard password.
 */

import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getConfig } from "../config.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { parseSessionCookie } from "../utils/parse-cookie.js";
import {
  createSession,
  validateSession,
  deleteSession,
} from "../auth/dashboard-session.js";
import {
  dashboardCsrf,
  sessionDashboardPrincipal,
} from "../auth/dashboard-csrf.js";
import { getAppearance } from "../ui-appearance/store.js";

/** Per-IP brute-force tracking: IP → { count, resetAt } */
const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (entry) failedAttempts.delete(ip); // cleanup expired
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    failedAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

/** Detect HTTPS from X-Forwarded-Proto (reverse proxy) or protocol. */
function isHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.toLowerCase() === "https";
  const url = new URL(c.req.url);
  return url.protocol === "https:";
}

function buildCookieString(name: string, value: string, maxAge: number, secure: boolean): string {
  let cookie = `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  if (secure) cookie += "; Secure";
  return cookie;
}

/** Reset rate-limit state — for tests only. */
export function _resetRateLimitForTest(): void {
  failedAttempts.clear();
}

export function createDashboardAuthRoutes(): Hono {
  const app = new Hono();

  // Theme preference is non-sensitive and is needed before the dashboard
  // session exists so the login screen uses the same appearance as the app.
  app.get("/auth/dashboard-preferences", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ theme: getAppearance().theme });
  });

  // POST /auth/dashboard-login — validate dashboard.admin_key and set session cookie
  app.post("/auth/dashboard-login", async (c) => {
    const config = getConfig();
    const remoteAddr = getRealClientIp(c, config.server.trust_proxy) || "unknown";

    // Rate limit check
    if (!checkRateLimit(remoteAddr)) {
      c.status(429);
      return c.json({ error: "Too many login attempts. Try again later." });
    }

    let body: { password?: string };
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Invalid JSON body" });
    }

    const password = body.password;
    if (!password || typeof password !== "string") {
      c.status(400);
      return c.json({ error: "Password is required" });
    }

    const key = config.dashboard.admin_key;
    const a = Buffer.from(password);
    const b = Buffer.from(key);
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
      recordFailure(remoteAddr);
      c.status(401);
      return c.json({ error: "Invalid password" });
    }

    const session = createSession();
    const maxAge = config.session.ttl_minutes * 60;
    const secure = isHttps(c);
    c.header("Set-Cookie", buildCookieString("_codex_session", session.id, maxAge, secure));
    return c.json({ success: true });
  });

  // POST /auth/dashboard-logout — clear session and cookie
  app.post("/auth/dashboard-logout", (c) => {
    const sessionId = parseSessionCookie(c.req.header("cookie"));
    if (sessionId) {
      deleteSession(sessionId);
    }
    const secure = isHttps(c);
    c.header("Set-Cookie", buildCookieString("_codex_session", "", 0, secure));
    return c.json({ success: true });
  });

  // GET /admin/csrf — mint a token for a browser session or local dashboard.
  app.get("/admin/csrf", (c) => {
    const cookieHeader = c.req.header("cookie");
    let principal: string | undefined;

    const sessionId = parseSessionCookie(cookieHeader);
    if (!sessionId || !validateSession(sessionId)) {
      c.status(403);
      return c.json({ error: "Valid dashboard session required" });
    }
    principal = sessionDashboardPrincipal(sessionId);

    if (!principal) {
      c.status(403);
      return c.json({ error: "CSRF token is only available to dashboard browser principals" });
    }

    return c.json(dashboardCsrf.issue(principal));
  });

  // GET /auth/dashboard-status — check if login is required and current auth state
  app.get("/auth/dashboard-status", (c) => {
    // Check session
    const sessionId = parseSessionCookie(c.req.header("cookie"));
    const authenticated = !!sessionId && validateSession(sessionId);

    return c.json({ required: true, authenticated });
  });

  return app;
}
