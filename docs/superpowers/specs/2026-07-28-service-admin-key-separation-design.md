# Service and Administration Key Separation Design

Date: 2026-07-28
Status: Approved for implementation

## Objective

Separate the credential used by proxy clients from the credential used to administer the Web dashboard and management APIs. A service credential must never grant administrative authority, and an administration credential must never grant model-inference authority.

This change includes the Web UI changes needed to present and manage the two credentials clearly.

## Configuration contract

The existing service credential remains:

```yaml
server:
  proxy_api_key: pwd
```

`server.proxy_api_key` is used only by model/proxy clients and internal service integrations such as the Ollama bridge. Its existing first-run default value remains `pwd`; operators may replace it when needed.

Add a mandatory administration credential:

```yaml
dashboard:
  admin_key: <randomly-generated-secret>
```

`dashboard.admin_key` protects Dashboard login and management API automation. It is never copied from, compared with, or allowed to fall back to `server.proxy_api_key`.

### Strict migration

- When an existing installation has no `dashboard.admin_key`, startup generates a cryptographically strong random key and persists it to `data/local.yaml`.
- The legacy `server.proxy_api_key`, including the default `pwd`, is never accepted as a Dashboard password or management Bearer token.
- The generated administration key is shown only in the one-time startup migration message. It is not returned by normal APIs or rendered by the Dashboard after initial generation.
- A new installation keeps `server.proxy_api_key: pwd` and independently generates a random administration key.
- The administration key cannot be null or empty. Management authentication cannot be disabled through configuration.
- Changing the administration key revokes all existing Dashboard sessions and CSRF tokens.
- Changing or clearing the service key does not affect Dashboard sessions.

Optional environment-variable support may expose `CODEX_PROXY_API_KEY` and `CODEX_DASHBOARD_ADMIN_KEY`. Environment values override runtime configuration without being persisted or logged. If an administration key is supplied through the environment, startup does not generate or persist another one.

## Authorization boundaries

Requests are classified into explicit public, service, and management surfaces.

### Public surface

Only endpoints required before authentication remain public:

- the Dashboard HTML shell and static assets;
- Dashboard login, logout, status, and non-sensitive pre-login appearance preference;
- health checks;
- OAuth callback endpoints that must be reachable during an in-progress authorization flow.

Public classification is explicit. A route is not public merely because it falls outside `/admin`.

### Service surface

The service surface includes `/v1/*`, `/v1beta/*`, compatibility `/responses*`, model catalog endpoints, and other inference-compatible endpoints.

- It accepts `server.proxy_api_key` and existing account-level `codex-proxy-*` keys.
- It rejects `dashboard.admin_key` and Dashboard session cookies.
- `/v1/models`, `/v1/models/catalog`, and model information endpoints receive the same service authentication as inference routes.

### Management surface

The management surface includes:

- `/admin/*`;
- management operations currently located under `/auth/*`, including account, third-party provider-key, quota, cookie, import, export, and token-management routes;
- `/api/proxies/*`;
- `/debug/*`;
- future management routes explicitly registered in the management policy.

Browser requests authenticate with an HttpOnly Dashboard session created by submitting `dashboard.admin_key`. Management mutations additionally require the existing same-origin and CSRF checks.

Automation may use `Authorization: Bearer <dashboard.admin_key>`. A service key is never accepted on the management surface.

Localhost receives no authentication bypass. Requests from `127.0.0.1`, `::1`, Electron, direct local browsers, and trusted reverse proxies follow the same management-authentication rules. Client addresses remain relevant only for rate limiting and audit context.

The hand-written `server.proxy_api_key` check on `/admin/refresh-models` is removed in favor of the unified management policy.

OAuth callback endpoints remain public only where required to finish an already-created authorization transaction. Operations that begin a new login, import local CLI credentials, submit tokens, or mutate accounts remain management-only.

## Dashboard behavior

The settings UI is split into two clearly labeled sections.

### Service API Key

- Displays the configured service key for SDK, CLI, code-example, and API Configuration use.
- Allows an authenticated administrator to copy, replace, or clear it.
- Explains that the default remains `pwd` until the operator chooses to replace it.
- Never describes this value as a Dashboard password.

### Dashboard/Admin Key

- Shows only whether an administration key is configured.
- Never reads or displays the existing plaintext key.
- Allows replacement with a new non-empty value.
- Warns that saving revokes all Dashboard sessions and requires immediate re-login.
- Cannot be cleared or disabled.

All browser management hooks stop attaching the service key as an Authorization header. They use the Dashboard session and the shared CSRF-aware administration fetch path. API Configuration and client examples continue to use the service key.

After an administration-key replacement succeeds, the client clears its CSRF cache and transitions to the login screen. Service-key changes leave the management session intact.

## Other credential-bearing integrations

- `official_agent.api_key` remains independent and unchanged.
- Account-level `codex-proxy-*` keys remain service credentials only.
- The Ollama bridge continues to inject the service key when forwarding to the main proxy and never receives the administration key.
- Because the Ollama bridge has no inbound authentication, it may listen only on a loopback address. A non-loopback configuration is rejected until an independent Ollama inbound-authentication design exists.
- Startup output labels the proxy credential as `Service API key`. The administration key is emitted only by the one-time generation/migration message.

## Error handling

- Missing or invalid management credentials return a management-shaped 401 response.
- A valid administration credential sent to a service endpoint receives the existing protocol-specific invalid API-key response.
- Management mutations without a valid CSRF token or exact origin continue to return 403.
- Startup fails closed if neither a valid configured administration key nor a successfully generated/persisted key is available.
- Administration-key rotation persists the new value before revoking sessions. If persistence fails, the current key and sessions remain valid and the request returns an error.

## Test and acceptance contract

Implementation follows test-driven development. The regression matrix must prove:

1. The service key can call service endpoints and cannot read or mutate any management route.
2. The administration key can log in and automate management routes but cannot call service endpoints.
3. Localhost cannot read or mutate management data without administration authentication.
4. A Dashboard session plus CSRF token can use every management route family, including management routes outside `/admin/*`.
5. An old single-key installation generates and persists a distinct administration key; its service key cannot log in to the Dashboard.
6. A fresh installation retains service key `pwd` and generates a different strong random administration key.
7. Replacing the administration key revokes all existing sessions and CSRF tokens.
8. Replacing or clearing the service key does not revoke a Dashboard session.
9. The administration key is absent from status, settings-read, UI, and ordinary log responses.
10. `/v1/models*` requires a service credential.
11. Official Agent credential behavior is unchanged.
12. Ollama forwarding uses only the service credential and a non-loopback listener is rejected.
13. Browser management requests no longer attach the service key as a management Bearer token.

Targeted unit and integration tests are followed by type checking, linting, the relevant frontend suite, the relevant backend suite, and a production build. Existing unrelated worktree changes are preserved.

## Documentation

Update the Chinese and English README, API references, Docker/environment examples, startup messaging, Dashboard labels, login help, and translations to distinguish:

- Service API key: client and proxy traffic only; default `pwd` is retained.
- Dashboard/Admin key: management only; independently generated, mandatory, and never recoverable through the UI.

