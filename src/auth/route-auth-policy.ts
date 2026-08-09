export type RequestAuthSurface = "public" | "service" | "independent" | "management";

const PUBLIC_METHOD_PATHS = new Set([
  "GET /",
  "GET /health",
  "POST /auth/dashboard-login",
  "POST /auth/dashboard-logout",
  "GET /auth/dashboard-status",
  "GET /auth/dashboard-preferences",
  "GET /auth/callback",
  "GET /admin/ui-background",
]);

export function classifyRequestPath(path: string, method = "GET"): RequestAuthSurface {
  const normalizedMethod = method.toUpperCase();
  if (PUBLIC_METHOD_PATHS.has(`${normalizedMethod} ${path}`)) return "public";
  if (normalizedMethod === "GET" && path.startsWith("/assets/")) return "public";
  if (
    path === "/responses" ||
    path.startsWith("/responses/") ||
    path.startsWith("/v1/") ||
    path.startsWith("/v1beta/")
  ) return "service";
  if (path.startsWith("/official-agent/") || path.startsWith("/integration/account-factory/v1/")) return "independent";
  return "management";
}
