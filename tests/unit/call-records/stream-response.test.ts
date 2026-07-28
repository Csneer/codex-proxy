import { describe, expect, it } from "vitest";
import {
  createStreamResponseCapture,
  getStreamResponseCaptureMetadata,
} from "@src/call-records/stream-response.js";

function append(capture: ReturnType<typeof createStreamResponseCapture>, chunks: string[]): number {
  for (const chunk of chunks) capture.appendWrittenChunk(chunk);
  return chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
}

describe("createStreamResponseCapture", () => {
  it("reconstructs split CRLF SSE while dropping framing, heartbeats, and DONE", () => {
    const capture = createStreamResponseCapture(4096);
    const originalBytes = append(capture, [
      ": ping\r\n\r\n",
      "event: response.output_text.delta\r\ndata: {\"delta\":\"你",
      "好\"}\r\n\r\ndata: [DONE]\r\n\r\n",
    ]);

    const result = capture.finish();
    expect(result).toEqual({ output_text: "你好" });
    expect(getStreamResponseCaptureMetadata(result)).toEqual({ originalBytes, truncated: false });
  });

  it("keeps the final display answer after a large volume of private events", () => {
    const capture = createStreamResponseCapture(1024);
    const chunks = Array.from({ length: 500 }, (_, index) =>
      `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ delta: `private-${index}-${"x".repeat(200)}` })}\n\n`,
    );
    chunks.push(
      `event: response.custom_tool_call_input.delta\ndata: ${JSON.stringify({ delta: "secret arguments" })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "最终回答" })}\n\n`,
    );
    const originalBytes = append(capture, chunks);

    const result = capture.finish();
    expect(result).toEqual({ output_text: "最终回答" });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain("secret arguments");
    expect(getStreamResponseCaptureMetadata(result)).toEqual({ originalBytes, truncated: false });
  });

  it.each([
    [
      "Responses",
      [
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "response " })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "text" })}\n\n`,
      ],
      "response text",
    ],
    [
      "Anthropic",
      [
        `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "text_delta", text: "anthropic " } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "text_delta", text: "text" } })}\n\n`,
      ],
      "anthropic text",
    ],
    [
      "OpenAI chat",
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "openai " } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "text" } }] })}\n\n`,
      ],
      "openai text",
    ],
    [
      "Gemini",
      [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "gemini " }, { thought: true, text: "private thought" }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "text" }] } }] })}\n\n`,
      ],
      "gemini text",
    ],
    [
      "official agent",
      [
        `event: item/agentMessage/delta\ndata: ${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "official " } })}\n\n`,
        `event: item/agentMessage/delta\ndata: ${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "text" } })}\n\n`,
      ],
      "official text",
    ],
  ])("captures %s display text", (_label, chunks, expected) => {
    const capture = createStreamResponseCapture(4096);
    append(capture, chunks as string[]);
    expect(capture.finish()).toEqual({ output_text: expected });
  });

  it("prefers streamed deltas over duplicated completion fallbacks", () => {
    const capture = createStreamResponseCapture(4096);
    append(capture, [
      `event: response.output_item.done\ndata: ${JSON.stringify({ item: { type: "message", content: [{ type: "output_text", text: "fallback" }] } })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ response: { output_text: "completed" } })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "final " })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "answer" })}\n\n`,
    ]);

    expect(capture.finish()).toEqual({ output_text: "final answer" });
  });

  it("keeps only tool names and completion statuses across streaming protocols", () => {
    const capture = createStreamResponseCapture(4096);
    append(capture, [
      `event: response.output_item.added\ndata: ${JSON.stringify({ item: { type: "custom_tool_call", id: "call-1", name: "exec", input: "private command" } })}\n\n`,
      `event: response.custom_tool_call_input.delta\ndata: ${JSON.stringify({ delta: "private arguments" })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ item: { type: "custom_tool_call", id: "call-1", name: "exec", status: "completed", input: "private command" } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "tool_use", id: "tool-2", name: "read", input: { path: "/secret" } } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-3", function: { name: "search", arguments: "private" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: "call-4", name: "fetch", args: { url: "private" } } }] } }] })}\n\n`,
    ]);

    const result = capture.finish();
    expect(result).toEqual({
      output_text: "",
      tool_activities: [
        { name: "exec", status: "已完成" },
        { name: "read", status: "已完成" },
        { name: "search", status: "已完成" },
        { name: "fetch", status: "已完成" },
      ],
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain("private");
    expect(json).not.toContain("arguments");
    expect(json).not.toContain("/secret");
  });

  it("strictly bounds UTF-8 display content while counting the complete raw stream", () => {
    const capture = createStreamResponseCapture(1024);
    const chunks = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "🙂".repeat(2000) })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "tail" })}\n\n`,
    ];
    const originalBytes = append(capture, chunks);

    const result = capture.finish() as { output_text: string; truncated: true; original_bytes: number };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
    expect(result.output_text).not.toContain("�");
    expect(result.truncated).toBe(true);
    expect(result.original_bytes).toBe(originalBytes);
    expect(getStreamResponseCaptureMetadata(result)).toEqual({ originalBytes, truncated: true });
  });
});
