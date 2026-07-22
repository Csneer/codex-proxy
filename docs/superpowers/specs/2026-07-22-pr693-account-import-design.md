# PR #693 Account Identity Import Design

## Goal

Import structurally valid Codex/Sub2API credentials that lack `chatgpt_account_id` without weakening authentication or bypassing the service's configured proxy.

## Compatibility boundary

- Keep the existing strict validation path for normal access tokens.
- Treat only a structurally valid token whose account ID is absent as recoverable.
- Treat file-provided account, organization, user, email, plan, and ID-token values as hints.
- Require an authenticated upstream response to establish the workspace account ID before persistence.
- Resolve all discovery traffic through the runtime proxy selected by the service.
- Preserve the existing rule that refresh-token exchange is not immediately followed by quota probing.

## Components and data flow

1. `token-metadata.ts` extracts portable identity hints from access and ID tokens and records the source of the account ID.
2. `account-identity-resolver.ts` queries `/accounts/check`, with a verified `/wham/usage` fallback, and returns authoritative identity metadata.
3. `AccountImportService` retains strict validation, invokes discovery only for the missing-account-ID compatibility case, redacts credentials from errors, and passes resolved metadata into the account pool.
4. Account registry/persistence stores optional `organizationId` and `accountIdSource` fields while normalizing legacy files to null values.
5. Transfer formats preserve Sub2API metadata as hints and export portable organization metadata.
6. The account import UI shows the first concrete server error in addition to aggregate counts.

## Error and security behavior

- Malformed, expired, or otherwise invalid tokens remain rejected.
- File-level account IDs cannot directly control the `ChatGPT-Account-Id` request header.
- Discovery retries one transport failure, never includes upstream response bodies in errors, and rejects invalid or mismatched IDs.
- Import errors redact JWTs, refresh tokens, and bearer credentials.
- A failed discovery never creates or updates an account.

## Testing

- Unit tests cover token metadata precedence, identity response parsing, proxy propagation, usage fallback verification, malformed responses, and credential redaction.
- Service tests cover direct-token, refresh-token, duplicate, and missing-account-ID imports.
- Transfer-format and frontend tests cover Sub2API hints and concrete error display.
- Existing account pool, quota probe, scheduler, typecheck, web build, and project build checks remain green.

## PR #692 scope

PR #692 is already represented locally by GPT-5.6 defaults, model-family mapping, context length, and regression tests. No duplicate code will be imported unless verification identifies a missing case.
