import type { MiddlewareHandler } from "hono";
import { getConfig } from "../config.js";
import { isLoopbackHostname, normalizeHostname } from "../utils/host.js";

/**
 * CORS middleware — allows requests from loopback origins and configured hosts.
 * Handles OPTIONS preflight and sets response headers for API routes only.
 */
export const cors: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("Origin");
  const accountFactory = isAccountFactoryPath(c.req.path);
  const corsEnabled = accountFactory || isCorsEnabledPath(c.req.path);
  const allowedOrigin = !corsEnabled
    ? null
    : accountFactory
      ? getAccountFactoryAllowedOrigin(origin)
      : getAllowedOrigin(origin);

  if (corsEnabled && c.req.method === "OPTIONS") {
    if (!allowedOrigin) {
      return c.body(null, 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": accountFactory ? "GET,POST,PATCH,OPTIONS" : "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": accountFactory ? "Content-Type, X-Account-Factory-Token" : "*",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      },
    });
  }

  await next();

  if (allowedOrigin) {
    c.header("Access-Control-Allow-Origin", allowedOrigin);
    c.header("Vary", "Origin", { append: true });
  }
};

function isCorsEnabledPath(path: string): boolean {
  return path.startsWith("/v1/") ||
    path.startsWith("/v1beta/") ||
    path === "/responses" ||
    path.startsWith("/responses/") ||
    path.startsWith("/official-agent/");
}

function isAccountFactoryPath(path: string): boolean {
  return path === "/integration/account-factory/v1" || path.startsWith("/integration/account-factory/v1/");
}

function getAccountFactoryAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  const accountFactory = getConfig().account_factory;
  if (!accountFactory.enabled) return null;
  if (accountFactory.allowed_extension_ids.includes("*") && origin.startsWith("chrome-extension://")) return origin;
  return accountFactory.allowed_extension_ids.some((id) => origin === `chrome-extension://${id}`) ? origin : null;
}

export function getAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    if (isLoopbackHostname(url.hostname)) {
      return url.origin;
    }

    const config = getConfig();
    const allowedHosts = config.server.cors;
    if (allowedHosts.length > 0) {
      const normalizedHost = normalizeHostname(url.hostname);
      if (allowedHosts.some((h: string) => {
        // Strip scheme from config entry before normalizing
        const configHost = h.replace(/^https?:\/\//, '');
        return normalizeHostname(configHost) === normalizedHost;
      })) {
        return url.origin;
      }
    }

    return null;
  } catch {
    return null;
  }
}
