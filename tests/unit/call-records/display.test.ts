import { describe, expect, it } from "vitest";
import {
  extractDisplayInput,
  extractDisplayOutput,
  extractDisplayTools,
  serializeDisplayPayload,
} from "@src/call-records/display.js";

describe("call record display payloads", () => {
  it("extracts only user-visible Responses input", () => {
    expect(extractDisplayInput({
      instructions: "do not persist system instructions",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "internal" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "visible input" }] },
      ],
    })).toBe("visible input");
  });

  it("extracts user-visible OpenAI, Anthropic, and Gemini inputs", () => {
    expect(extractDisplayInput({
      messages: [
        { role: "system", content: "private system prompt" },
        { role: "user", content: "OpenAI input" },
      ],
    })).toBe("OpenAI input");
    expect(extractDisplayInput({
      system: "private system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "Anthropic input" }] }],
    })).toBe("Anthropic input");
    expect(extractDisplayInput({
      systemInstruction: { parts: [{ text: "private system prompt" }] },
      contents: [{ role: "user", parts: [{ text: "Gemini input" }] }],
    })).toBe("Gemini input");
  });

  it("extracts only allowlisted non-streaming output text", () => {
    expect(extractDisplayOutput({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "private reasoning" }] },
        { type: "function_call", name: "exec", arguments: "private arguments" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Responses answer" }] },
      ],
    })).toBe("Responses answer");
    expect(extractDisplayOutput({
      content: [
        { type: "thinking", thinking: "private reasoning", text: "private reasoning" },
        { type: "tool_use", name: "exec", input: { cmd: "private arguments" } },
        { type: "text", text: "Anthropic answer" },
      ],
    })).toBe("Anthropic answer");
    expect(extractDisplayOutput({
      candidates: [{ content: { parts: [
        { thought: true, text: "private reasoning" },
        { functionCall: { name: "exec", args: { cmd: "private arguments" } } },
        { text: "Gemini answer" },
      ] } }],
    })).toBe("Gemini answer");
  });

  it("extracts allowlisted streamed output without reasoning or tool arguments", () => {
    expect(extractDisplayOutput([
      { event: "response.reasoning_summary_text.delta", data: { delta: "private reasoning" } },
      { event: "response.custom_tool_call_input.delta", data: { delta: "secret arguments" } },
      { event: "response.output_text.delta", data: { delta: "visible " } },
      { event: "response.output_text.delta", data: { delta: "answer" } },
    ])).toBe("visible answer");
  });

  it("supports official-agent display input and output", () => {
    expect(extractDisplayInput({ text: "Inspect the app", cwd: "/workspace/app" })).toBe("Inspect the app");
    expect(extractDisplayOutput([
      { event: "item/agentMessage/delta", data: { params: { delta: "official " } } },
      { event: "item/agentMessage/delta", data: { params: { delta: "answer" } } },
    ])).toBe("official answer");
  });

  it("retains only tool names and statuses for tool-only responses", () => {
    expect(extractDisplayTools([
      { event: "response.output_item.done", data: { item: { type: "custom_tool_call", id: "call-1", name: "exec", status: "completed", input: "pwd" } } },
      { event: "response.custom_tool_call_input.delta", data: { delta: "private command" } },
    ])).toEqual([{ name: "exec", status: "已完成" }]);
  });

  it("extracts non-streaming Anthropic, OpenAI, and Gemini tool summaries", () => {
    expect(extractDisplayTools([
      { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read", input: { path: "/private" } } } },
      { event: "content_block_stop", data: { index: 0 } },
      { choices: [{ message: { tool_calls: [{ id: "call-2", function: { name: "search", arguments: "private" } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-3", name: "fetch", args: { url: "private" } } }] } }] },
    ])).toEqual([
      { name: "read", status: "已完成" },
      { name: "search", status: "已完成" },
      { name: "fetch", status: "已完成" },
    ]);
  });

  it("keeps the complete JSON wrapper within the byte limit", () => {
    const result = serializeDisplayPayload("output", "🙂".repeat(2000), 1024, 8000);
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(1024);
    expect(() => JSON.parse(result.json)).not.toThrow();
    expect(result.truncated).toBe(true);
  });

  it("trims oversized tool summaries to keep the complete wrapper within the byte limit", () => {
    const tools = Array.from({ length: 200 }, (_, index) => ({
      name: `tool-${index}-${"x".repeat(100)}`,
      status: "已完成",
    }));
    const result = serializeDisplayPayload("output", "visible", 1024, 40_000, tools);
    const parsed = JSON.parse(result.json) as { tool_activities?: unknown[] };

    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(1024);
    expect(parsed.tool_activities?.length ?? 0).toBeLessThan(tools.length);
    expect(result.truncated).toBe(true);
  });
});
