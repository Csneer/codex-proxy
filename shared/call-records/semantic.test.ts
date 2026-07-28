import { describe, expect, it } from "vitest";
import { extractInputText, extractOutputText, extractToolActivities } from "./semantic.js";

describe("call record semantic extraction", () => {
  it("extracts input text from the lightweight stored payload", () => {
    expect(extractInputText({ input_text: "前端需要展示的输入" })).toBe("前端需要展示的输入");
  });

  it("extracts user text from Responses input message content", () => {
    expect(extractInputText({
      model: "gpt-5.6-sol",
      input: [
        { type: "additional_tools", tools: [{ name: "exec", description: "ignore this" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "保留这段用户输入" }] },
      ],
    })).toBe("保留这段用户输入");
  });

  it("joins streamed output deltas and ignores protocol metadata", () => {
    expect(extractOutputText([
      { event: "response.created", data: { response: { id: "resp_1" } } },
      { event: "response.output_text.delta", data: { delta: "第一段" } },
      { event: "response.output_text.delta", data: { delta: "第二段" } },
      { event: "response.completed", data: { response: { status: "completed" } } },
    ])).toBe("第一段第二段");
  });

  it("does not mistake reasoning summaries or tool arguments for assistant text", () => {
    expect(extractOutputText([
      { event: "response.reasoning_summary_text.delta", data: { delta: "内部推理" } },
      { event: "response.custom_tool_call_input.delta", data: { delta: "{\"cmd\":\"ls\"}" } },
      { event: "response.output_text.delta", data: { delta: "最终" } },
      { event: "response.output_text.delta", data: { delta: "回答" } },
    ])).toBe("最终回答");
  });

  it("extracts Anthropic text_delta events", () => {
    expect(extractOutputText([
      { event: "content_block_delta", data: { delta: { type: "text_delta", text: "Anthropic" } } },
      { event: "content_block_delta", data: { delta: { type: "text_delta", text: "文本" } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ])).toBe("Anthropic文本");
  });

  it("uses a completed text event only when no deltas were captured", () => {
    expect(extractOutputText([
      { event: "response.output_text.delta", data: { delta: "一次" } },
      { event: "response.output_text.done", data: { text: "一次" } },
    ])).toBe("一次");
    expect(extractOutputText([
      { event: "response.output_text.done", data: { text: "完成文本" } },
    ])).toBe("完成文本");
  });

  it("extracts text from non-streaming Responses, OpenAI, and Anthropic shapes", () => {
    expect(extractOutputText({
      output_text: "Responses 完成",
      output: [{ type: "message", content: [{ type: "output_text", text: "Responses 完成" }] }],
    })).toBe("Responses 完成");
    expect(extractOutputText({ choices: [{ message: { content: "OpenAI 完成" } }] })).toBe("OpenAI 完成");
    expect(extractOutputText({ content: [{ type: "text", text: "Anthropic 完成" }] })).toBe("Anthropic 完成");
  });

  it("unwraps a data envelope around a non-streaming response", () => {
    expect(extractOutputText({ data: { choices: [{ message: { content: "带包装的 OpenAI" } }] } })).toBe("带包装的 OpenAI");
  });

  it("extracts text from a non-streaming Gemini response", () => {
    expect(extractOutputText({
      candidates: [{ content: { parts: [{ text: "Gemini 完成" }] } }],
    })).toBe("Gemini 完成");
  });

  it("keeps a plain-text response body visible", () => {
    expect(extractOutputText("纯文本响应")).toBe("纯文本响应");
  });

  it("extracts semantic text from a truncated capture wrapper", () => {
    expect(extractOutputText({
      truncated: true,
      original_bytes: 9000,
      omitted_events: 3,
      events: [
        { event: "response.output_text.delta", data: { delta: "截断后仍保留" } },
      ],
    })).toBe("截断后仍保留");
  });

  it("summarizes tool activity without treating tool input as model prose", () => {
    expect(extractToolActivities([
      { event: "response.output_item.added", data: { item: { type: "custom_tool_call", id: "ctc_1", name: "exec" } } },
      { event: "response.output_item.done", data: { item: { type: "custom_tool_call", id: "ctc_1", name: "exec", status: "completed", input: "very long command" } } },
    ])).toEqual([{ name: "exec", status: "已完成" }]);
  });

  it("summarizes tools in a non-streaming Responses result", () => {
    expect(extractToolActivities({
      output: [{ type: "function_call", call_id: "call_1", name: "exec", status: "completed", arguments: '{"cmd":"ls"}' }],
    })).toEqual([{ name: "exec", status: "已完成" }]);
  });

  it("summarizes non-streaming Anthropic, OpenAI, and Gemini tools", () => {
    expect(extractToolActivities({
      content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "pwd" } }],
    })).toEqual([{ name: "Bash", status: "已完成" }]);
    expect(extractToolActivities({
      choices: [{ message: { tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "{}" } }] } }],
    })).toEqual([{ name: "exec", status: "已完成" }]);
    expect(extractToolActivities({
      candidates: [{ content: { parts: [{ functionCall: { name: "search", args: {} } }] } }],
    })).toEqual([{ name: "search", status: "已完成" }]);
  });

  it("unwraps a data envelope around non-streaming tools", () => {
    expect(extractToolActivities({
      data: { output: [{ type: "custom_tool_call", id: "call_1", name: "exec", status: "completed" }] },
    })).toEqual([{ name: "exec", status: "已完成" }]);
  });

  it("extracts OpenAI chat completion chunks", () => {
    expect(extractOutputText([
      { data: { choices: [{ delta: { role: "assistant" } }] } },
      { data: { choices: [{ delta: { content: "Open" } }] } },
      { data: { choices: [{ delta: { content: "AI" } }] } },
    ])).toBe("OpenAI");
  });

  it("summarizes Anthropic tool_use blocks", () => {
    expect(extractToolActivities([
      { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "call_1", name: "Bash" } } },
      { event: "content_block_stop", data: { index: 0 } },
    ])).toEqual([{ name: "Bash", status: "已完成" }]);
  });

  it("extracts Gemini candidate chunks and official agent deltas", () => {
    expect(extractOutputText([
      { data: { candidates: [{ content: { parts: [{ text: "Gem" }] } }] } },
      { data: { candidates: [{ content: { parts: [{ text: "ini" }] } }] } },
    ])).toBe("Gemini");
    expect(extractOutputText([
      { event: "official_agent.result", data: { turn: { id: "turn_1" } } },
      { event: "item/agentMessage/delta", data: { method: "item/agentMessage/delta", params: { delta: "官方" } } },
      { event: "item/agentMessage/delta", data: { method: "item/agentMessage/delta", params: { delta: "代理" } } },
    ])).toBe("官方代理");
  });
});
