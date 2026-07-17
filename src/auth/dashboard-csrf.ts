import { createHash, randomBytes, timingSafeEqual } from "crypto";

const DEFAULT_TTL_MS = 15 * 60_000;
const systemNow = (): number => Date.now();

export interface CsrfTokenRecord {
  token: string;
  expiresAt: number;
}

export interface DashboardCsrfStore {
  issue(principal: string): CsrfTokenRecord;
  verify(principal: string, candidate: string): boolean;
  revoke(principal: string): void;
  clear(): void;
  setNowForTest(now: () => number): void;
  getSizeForTest(): number;
}

export interface DashboardCsrfStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function sessionDashboardPrincipal(sessionId: string): string {
  return `session:${sessionId}`;
}

export function localDashboardPrincipal(remoteAddr: string): string {
  return `local:${remoteAddr}`;
}

export function createDashboardCsrfStore(
  options: DashboardCsrfStoreOptions = {},
): DashboardCsrfStore {
  const tokens = new Map<string, CsrfTokenRecord>();
  const initialNow = options.now ?? systemNow;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let now = initialNow;

  function pruneExpired(): void {
    const current = now();
    for (const [principal, record] of tokens) {
      if (current >= record.expiresAt) tokens.delete(principal);
    }
  }

  return {
    issue(principal) {
      pruneExpired();
      const existing = tokens.get(principal);
      if (existing && now() < existing.expiresAt) return existing;
      const token = randomBytes(32).toString("base64url");
      const record = { token, expiresAt: now() + ttlMs };
      tokens.set(principal, record);
      return record;
    },

    verify(principal, candidate) {
      pruneExpired();
      const record = tokens.get(principal);
      if (!record) return false;
      return constantTimeEqual(record.token, candidate);
    },

    revoke(principal) {
      tokens.delete(principal);
    },

    clear() {
      tokens.clear();
      now = initialNow;
    },

    setNowForTest(testNow) {
      now = testNow;
    },

    getSizeForTest() {
      pruneExpired();
      return tokens.size;
    },
  };
}

export const dashboardCsrf = createDashboardCsrfStore();
