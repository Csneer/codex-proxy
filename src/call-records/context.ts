import { createHash } from "node:crypto";
import type { CallContextHints, ResolvedCallContext } from "./types.js";

const ID_MAX_LENGTH = 512;
const CWD_MAX_LENGTH = 4096;

function normalize(value: string | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

export function readExplicitCallContextHeaders(headers: Headers): Partial<CallContextHints> {
  return {
    explicitSessionId: headers.get("x-codex-proxy-session-id") ?? undefined,
    explicitTaskId: headers.get("x-codex-proxy-task-id") ?? undefined,
    explicitCwd: headers.get("x-codex-proxy-cwd") ?? undefined,
  };
}

export function resolveCallContext(hints: CallContextHints): ResolvedCallContext {
  const explicitSessionId = normalize(hints.explicitSessionId, ID_MAX_LENGTH);
  const explicitTaskId = normalize(hints.explicitTaskId, ID_MAX_LENGTH);
  const explicitCwd = normalize(hints.explicitCwd, CWD_MAX_LENGTH);
  const hasExplicit = explicitSessionId !== null || explicitTaskId !== null || explicitCwd !== null;

  const sessionId = explicitSessionId
    ?? normalize(hints.protocolSessionId, ID_MAX_LENGTH)
    ?? normalize(hints.derivedConversationId, ID_MAX_LENGTH);
  const taskId = explicitTaskId ?? normalize(hints.protocolTaskId, ID_MAX_LENGTH);
  const cwd = explicitCwd ?? normalize(hints.protocolCwd, CWD_MAX_LENGTH);
  const contextKey = sessionId === null && taskId === null && cwd === null
    ? null
    : createHash("sha256").update(JSON.stringify([sessionId, taskId, cwd])).digest("hex");

  return {
    sessionId,
    taskId,
    cwd,
    source: hasExplicit ? "proxy_headers" : hints.source,
    contextKey,
  };
}
