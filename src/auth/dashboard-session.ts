/**
 * Dashboard Session Store — in-memory session management for web dashboard login gate.
 *
 * Sessions are cookie-based and protect the dashboard for every client address.
 *
 * Sessions are NOT persisted — server restart requires re-login, which is acceptable.
 */

import { randomUUID } from "crypto";
import { getConfig } from "../config.js";
import { dashboardCsrf, sessionDashboardPrincipal } from "./dashboard-csrf.js";

export interface DashboardSession {
  id: string;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, DashboardSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function createSession(): DashboardSession {
  const config = getConfig();
  const ttlMs = config.session.ttl_minutes * 60_000;
  const now = Date.now();
  const session: DashboardSession = {
    id: randomUUID(),
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  sessions.set(session.id, session);
  return session;
}

export function validateSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  const now = Date.now();
  if (now >= session.expiresAt) {
    removeSession(id);
    return false;
  }
  // Sliding window: extend expiry on each valid access
  const config = getConfig();
  session.expiresAt = now + config.session.ttl_minutes * 60_000;
  return true;
}

export function deleteSession(id: string): void {
  removeSession(id);
}

export function removeSession(id: string): void {
  sessions.delete(id);
  dashboardCsrf.revoke(sessionDashboardPrincipal(id));
}

export function getSessionCount(): number {
  return sessions.size;
}

export function revokeAllSessions(): void {
  for (const id of [...sessions.keys()]) removeSession(id);
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now >= session.expiresAt) {
      removeSession(id);
    }
  }
}

export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  const config = getConfig();
  const intervalMs = config.session.cleanup_interval_minutes * 60_000;
  cleanupTimer = setInterval(cleanupExpired, intervalMs);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Reset all sessions — for tests only. */
export function _resetForTest(): void {
  revokeAllSessions();
  stopSessionCleanup();
  dashboardCsrf.clear();
}
