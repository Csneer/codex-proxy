import { describe, expect, it, vi } from "vitest";
import { createCallRecorder } from "@src/call-records/recorder.js";
import type { CompletedCallRecord } from "@src/call-records/types.js";

function fakeStore(insert = vi.fn(() => true)) {
  return { insert };
}

describe("createCallRecorder", () => {
  it("creates pending metadata without persisting", () => {
    const store = fakeStore();
    const recorder = createCallRecorder({
      store: store as never,
      isEnabled: () => true,
      maxBodyBytes: () => 1024,
      now: () => Date.parse("2026-07-11T10:00:00.000Z"),
    });
    const request = { prompt: "hello" };

    const pending = recorder.createPendingCall({
      requestId: "request-1",
      route: "/v1/responses",
      protocol: "responses",
      request,
      contextHints: { protocolSessionId: "session-1", source: "responses" },
      model: "gpt-5.4",
      stream: false,
    });

    expect(pending).toMatchObject({
      requestId: "request-1",
      startedAt: "2026-07-11T10:00:00.000Z",
      startedAtMs: Date.parse("2026-07-11T10:00:00.000Z"),
      route: "/v1/responses",
      protocol: "responses",
      request,
      finalized: false,
    });
    expect(store.insert).not.toHaveBeenCalled();
  });

  it("does not retain request bodies while disabled", () => {
    const store = fakeStore();
    const recorder = createCallRecorder({
      store: store as never,
      isEnabled: () => false,
      maxBodyBytes: () => 1024,
    });

    expect(recorder.createPendingCall({
      requestId: "request-disabled",
      route: "/v1/responses",
      protocol: "responses",
      request: { secret: "not retained" },
      contextHints: { source: "responses" },
      model: "gpt-5.4",
      stream: false,
    })).toBeUndefined();
  });

  it("finalizes once with enriched context, normalized usage, and bounded redacted bodies", () => {
    const insert = vi.fn((_record: CompletedCallRecord) => true);
    let now = Date.parse("2026-07-11T10:00:00.000Z");
    const recorder = createCallRecorder({
      store: fakeStore(insert) as never,
      isEnabled: () => true,
      maxBodyBytes: () => 1024,
      now: () => now,
    });
    const pending = recorder.createPendingCall({
      requestId: "request-1",
      route: "/v1/responses",
      protocol: "responses",
      request: { authorization: "Bearer secret-token-value", prompt: "🙂".repeat(2000) },
      contextHints: { protocolSessionId: "session-1", source: "responses" },
      model: "gpt-5.4",
      stream: true,
    })!;
    now += 2500;

    expect(recorder.finalizeSuccessfulCall(pending, {
      response: { owner: "person@example.com", text: "ok" },
      usage: { input_tokens: 42, output_tokens: 7 },
      provider: "codex",
      accountId: "account-1",
      upstreamModel: "gpt-5.4-upstream",
      responseId: "response-1",
      contextHints: { explicitTaskId: "task-1", protocolCwd: "/repo" },
    })).toBe(true);
    expect(recorder.finalizeSuccessfulCall(pending, {
      response: {}, provider: "codex",
    })).toBe(false);

    expect(insert).toHaveBeenCalledTimes(1);
    const persisted = insert.mock.calls[0][0];
    expect(persisted).toMatchObject({
      requestId: "request-1",
      completedAt: "2026-07-11T10:00:02.500Z",
      latencyMs: 2500,
      inputTokens: 42,
      outputTokens: 7,
      cachedTokens: 0,
      reasoningTokens: 0,
      imageInputTokens: 0,
      imageOutputTokens: 0,
      provider: "codex",
      accountId: "account-1",
      upstreamModel: "gpt-5.4-upstream",
      responseId: "response-1",
      context: expect.objectContaining({ sessionId: "session-1", taskId: "task-1", cwd: "/repo" }),
      requestTruncated: true,
      responseTruncated: false,
    });
    expect(Buffer.byteLength(persisted.requestJson)).toBeLessThanOrEqual(1024);
    expect(persisted.requestJson).not.toContain("secret-token-value");
    expect(persisted.responseJson).not.toContain("person@example.com");
  });

  it("swallows store failures and reports them without refinalizing", () => {
    const error = new Error("disk full");
    const onError = vi.fn();
    const recorder = createCallRecorder({
      store: fakeStore(vi.fn(() => { throw error; })) as never,
      isEnabled: () => true,
      maxBodyBytes: () => 1024,
      onError,
    });
    const pending = recorder.createPendingCall({
      requestId: "request-failed-write",
      route: "/v1/chat/completions",
      protocol: "openai",
      request: {},
      contextHints: { source: "openai" },
      model: "gpt-5.4",
      stream: false,
    })!;

    expect(() => recorder.finalizeSuccessfulCall(pending, { response: {}, provider: "codex" })).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error, "request-failed-write");
    expect(recorder.finalizeSuccessfulCall(pending, { response: {}, provider: "codex" })).toBe(false);
  });

  it("swallows diagnostic callback failures and clears the pending request", () => {
    const recorder = createCallRecorder({
      store: fakeStore(vi.fn(() => { throw new Error("disk full"); })) as never,
      isEnabled: () => true,
      maxBodyBytes: () => 1024,
      onError: () => { throw new Error("diagnostic sink failed"); },
    });
    const pending = recorder.createPendingCall({
      requestId: "request-double-failure",
      route: "/v1/responses",
      protocol: "responses",
      request: { prompt: "must be released" },
      contextHints: { source: "responses" },
      model: "gpt-5.4",
      stream: false,
    })!;

    expect(() => recorder.finalizeSuccessfulCall(pending, {
      response: {},
      provider: "codex",
    })).not.toThrow();
    expect(pending.request).toBeNull();
    expect(recorder.finalizeSuccessfulCall(pending, { response: {}, provider: "codex" })).toBe(false);
  });
});
