/**
 * Codex usage/quota API query.
 */

import { getConfig } from "../config.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";
import { CodexApiError, type CodexUsageResponse } from "./codex-types.js";

function usageUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.includes("/backend-api")) {
    return [`${trimmed}/wham/usage`, `${trimmed}/codex/usage`];
  }
  return [`${trimmed}/api/codex/usage`, `${trimmed}/codex/usage`];
}

export async function fetchUsage(
  headers: Record<string, string>,
  proxyUrl?: string | null,
  baseUrl?: string,
  injectedTransport?: TlsTransport,
): Promise<CodexUsageResponse> {
  const resolvedBaseUrl = baseUrl ?? getConfig().api.base_url;
  const transport = injectedTransport ?? getTransport();

  headers["Accept"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }

  let lastBody = "";
  let lastError: string | null = null;
  let lastHttpError: CodexApiError | null = null;
  for (const url of usageUrls(resolvedBaseUrl)) {
    let body: string;
    try {
      const result = await transport.get(url, headers, 15, proxyUrl);
      body = result.body;
      if (result.status < 200 || result.status >= 300) {
        const error = new CodexApiError(result.status, body);
        // A missing endpoint is the expected signal to try the compatibility
        // fallback URL. Authentication, quota, and account-state responses
        // are authoritative and must retain their original status/body.
        if (result.status === 404) {
          lastHttpError = error;
          lastBody = body;
          continue;
        }
        throw error;
      }
    } catch (err) {
      if (err instanceof CodexApiError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    lastBody = body;

    try {
      const parsed = JSON.parse(body) as CodexUsageResponse;
      if (!parsed.rate_limit) {
        lastError = `Unexpected response from ${url}: ${body.slice(0, 200)}`;
        continue;
      }
      return parsed;
    } catch (e) {
      if (e instanceof CodexApiError) throw e;
      lastError = `Invalid JSON from ${url}: ${body.slice(0, 200)}`;
    }
  }

  if (lastHttpError && !lastError) throw lastHttpError;
  if (lastBody) throw new CodexApiError(502, lastError ?? `Invalid usage response: ${lastBody.slice(0, 200)}`);
  throw new CodexApiError(0, `transport GET failed: ${lastError ?? "unknown error"}`);
}
