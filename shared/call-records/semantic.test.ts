import { describe, expect, it } from "vitest";
import { extractInputText, extractOutputText } from "./semantic.js";

describe("call record semantic extraction", () => {
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
});
