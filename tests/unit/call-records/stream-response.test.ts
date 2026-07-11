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
});
