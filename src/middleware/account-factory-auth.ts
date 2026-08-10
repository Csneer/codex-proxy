import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { getConfig } from "../config.js";
import type { AppConfig } from "../config-schema.js";
import { isLocalhostRequest } from "../utils/is-localhost.js";
import { log } from "../utils/logger.js";

const ACCOUNT_FACTORY_TOKEN_HEADER = "x-account-factory-token";

function sameToken(actual: string | undefined, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function hasAllowedExtensionOrigin(origin: string | undefined, extensionIds: string[]): boolean {
  if (!origin) return true;
  if (extensionIds.includes("*") && origin.startsWith("chrome-extension://")) return true;
  return extensionIds.some((id) => origin === `chrome-extension://${id}`);
}

function requestIsLocal(c: Context): boolean {
  try {
    return isLocalhostRequest(getConnInfo(c).remote.address ?? "");
  } catch {
    return false;
  }
}

function error(c: Context, status: 401 | 403 | 404, code: string): Response {
  c.status(status);
  return c.json({ error: code });
}

export function createAccountFactoryAuth(
  resolveConfig: () => AppConfig = getConfig,
  isLocalRequest: (c: Context) => boolean = requestIsLocal,
): MiddlewareHandler {
  return async (c, next) => {
    const config = resolveConfig().account_factory;
    if (!config.enabled) return error(c, 404, "feature_disabled");
    if (!isLocalRequest(c)) return error(c, 403, "loopback_required");
    const origin = c.req.header("origin");
    if (!hasAllowedExtensionOrigin(origin, config.allowed_extension_ids)) {
      log.warn("Account factory extension origin rejected", {
        origin: origin ?? "",
        allowedExtensionIds: config.allowed_extension_ids,
      });
      return error(c, 403, "origin_not_allowed");
    }
    if (!sameToken(c.req.header(ACCOUNT_FACTORY_TOKEN_HEADER), config.token)) {
      return error(c, 401, "unauthorized");
    }
    return next();
  };
}
