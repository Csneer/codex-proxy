import { describe, expect, it } from "vitest";
import { createStreamResponseCapture } from "@src/call-records/stream-response.js";

describe("createStreamResponseCapture", () => {
  it("reconstructs written SSE events without framing or heartbeats", () => {
    const capture = createStreamResponseCapture(4096);
    capture.appendWrittenChunk(": ping\n\n");
    capture.appendWrittenChunk("event: response.output_text.delta\ndata: {\"delta\":\"你");
    capture.appendWrittenChunk("好\"}\n\ndata: [DONE]\n\n");

    expect(capture.finish()).toEqual([
      { event: "response.output_text.delta", data: { delta: "你好" } },
    ]);
  });

  it("bounds captured stream content before persistence", () => {
    const capture = createStreamResponseCapture(64);
    capture.appendWrittenChunk(`data: ${JSON.stringify({ text: "x".repeat(200) })}\n\n`);
    expect(capture.finish()).toEqual(expect.objectContaining({ truncated: true }));
  });

  it("stops retaining events after the capture limit while counting the full stream", () => {
    const capture = createStreamResponseCapture(1024);
    for (let index = 0; index < 200; index++) {
      capture.appendWrittenChunk(`data: ${JSON.stringify({ index, text: "x".repeat(200) })}\n\n`);
    }

    const result = capture.finish() as {
      truncated: boolean;
      original_bytes: number;
      omitted_events: number;
      events: unknown;
    };
    expect(result.truncated).toBe(true);
    expect(result.original_bytes).toBeGreaterThan(40_000);
    expect(result.omitted_events).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.events))).toBeLessThanOrEqual(1024);
  });
});
