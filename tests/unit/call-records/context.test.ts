import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readExplicitCallContextHeaders,
  resolveCallContext,
} from "@src/call-records/context.js";

describe("resolveCallContext", () => {
  it("prefers explicit identities over protocol and derived fallbacks", () => {
    expect(resolveCallContext({
      explicitSessionId: " explicit-session ",
      explicitTaskId: "explicit-task",
      explicitCwd: " /workspace/project ",
      protocolSessionId: "protocol-session",
      protocolTaskId: "protocol-task",
      protocolCwd: "/protocol",
      derivedConversationId: "derived-session",
      source: "responses",
    })).toMatchObject({
      sessionId: "explicit-session",
      taskId: "explicit-task",
      cwd: "/workspace/project",
      source: "proxy_headers",
    });
  });

  it("uses protocol values before the derived conversation identity", () => {
    const result = resolveCallContext({
      protocolSessionId: "protocol-session",
      protocolTaskId: "protocol-task",
      derivedConversationId: "derived-session",
      source: "claude",
    });

    expect(result).toMatchObject({
      sessionId: "protocol-session",
      taskId: "protocol-task",
      cwd: null,
      source: "claude",
    });
  });

  it("ignores whitespace and overlong values and leaves missing identity ungrouped", () => {
    expect(resolveCallContext({
      explicitSessionId: "   ",
      protocolTaskId: "x".repeat(513),
      protocolCwd: "x".repeat(4097),
      source: "openai",
    })).toEqual({
      sessionId: null,
      taskId: null,
      cwd: null,
      source: "openai",
      contextKey: null,
    });
  });

  it("generates a stable SHA-256 key from normalized identity", () => {
    const hints = {
      protocolSessionId: " session-1 ",
      protocolTaskId: "task-1",
      protocolCwd: "/repo",
      source: "responses",
    };
    const expected = createHash("sha256")
      .update(JSON.stringify(["session-1", "task-1", "/repo"]))
      .digest("hex");

    expect(resolveCallContext(hints).contextKey).toBe(expected);
    expect(resolveCallContext(hints).contextKey).toBe(resolveCallContext({ ...hints }).contextKey);
  });
});

describe("readExplicitCallContextHeaders", () => {
  it("reads explicit proxy headers case-insensitively", () => {
    const headers = new Headers({
      "x-codex-proxy-session-id": "session",
      "x-codex-proxy-task-id": "task",
      "x-codex-proxy-cwd": "/repo",
    });

    expect(readExplicitCallContextHeaders(headers)).toEqual({
      explicitSessionId: "session",
      explicitTaskId: "task",
      explicitCwd: "/repo",
    });
  });
});
