/**
 * Account acquisition / release helpers for the proxy handler.
 *
 * Wraps AccountPool.acquire/release with logging and idempotent-release guard.
 */

import type { AccountPool } from "../../auth/account-pool.js";
import type { AcquiredAccount } from "../../auth/types.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

export type ReleaseGuard = Set<string> | Map<string, string | undefined>;

/**
 * Acquire an account from the pool for the given model.
 * Returns null when no account is available.
 */
export function acquireAccount(
  pool: AccountPool,
  model: string,
  excludeIds?: string[],
  tag?: string,
  preferredEntryId?: string,
  released?: ReleaseGuard,
): AcquiredAccount | null {
  const acquired = pool.acquire({ model, excludeIds, preferredEntryId });
  if (acquired && released instanceof Map) released.set(acquired.entryId, acquired.leaseId);
  if (!acquired && tag) {
    console.warn(`[${tag}] No available account for model "${model}"`);
  }
  return acquired;
}

/**
 * Release an account back to the pool.
 *
 * A request-scoped Map guard makes the release idempotent and selects the
 * exact lease for this entry. A Set remains supported for legacy callers.
 */
export function releaseAccount(
  pool: AccountPool,
  entryId: string,
  usage?: UsageInfo,
  guard?: ReleaseGuard,
): void {
  if (guard) {
    if (guard instanceof Map) {
      if (!guard.has(entryId)) return;
      const leaseId = guard.get(entryId);
      guard.delete(entryId);
      if (leaseId === undefined) {
        pool.release(entryId, usage);
      } else {
        pool.release(entryId, usage, leaseId);
      }
      return;
    }
    if (guard.has(entryId)) return;
    guard.add(entryId);
  }
  pool.release(entryId, usage);
}
