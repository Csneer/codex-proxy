import { readExplicitCallContextHeaders } from "./context.js";
import { getCallRecordRecorder } from "./service.js";
import type { CallContextHints, CallProtocol, PendingCallRecord, SuccessfulCallResult } from "./types.js";

export function beginCallRecord(input: {
  requestId: string;
  route: string;
  protocol: CallProtocol;
  request: unknown;
  headers: Headers;
  model: string;
  stream: boolean;
  contextHints: Omit<CallContextHints, "explicitSessionId" | "explicitTaskId" | "explicitCwd">;
}): PendingCallRecord | undefined {
  return getCallRecordRecorder()?.createPendingCall({
    requestId: input.requestId,
    route: input.route,
    protocol: input.protocol,
    request: input.request,
    model: input.model,
    stream: input.stream,
    contextHints: {
      ...input.contextHints,
      ...readExplicitCallContextHeaders(input.headers),
    },
  });
}

export function completeCallRecord(
  pending: PendingCallRecord | undefined,
  result: SuccessfulCallResult,
): boolean {
  return getCallRecordRecorder()?.finalizeSuccessfulCall(pending, result) ?? false;
}
