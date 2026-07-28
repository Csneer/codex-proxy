import { serializeDisplayPayload, type DisplayToolActivity } from "./display.js";

export interface StreamResponseCapture {
  appendWrittenChunk(chunk: string): void;
  finish(): unknown;
}

const CAPTURE_METADATA = Symbol("call-record-stream-capture");
const MAX_TOOL_ACTIVITIES = 128;
const MAX_TOOL_NAME_BYTES = 256;

interface CapturedStreamResponse {
  [CAPTURE_METADATA]: {
    originalBytes: number;
    truncated: boolean;
  };
}

interface ToolState extends DisplayToolActivity {
  id: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return Buffer.from(value).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

function messageContentText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => isObject(part)
    && (part.type === "output_text" || part.type === "text")
    && typeof part.text === "string"
    ? [part.text]
    : []);
}

function completedResponseText(value: unknown): string {
  if (!isObject(value)) return "";
  if (typeof value.output_text === "string") return value.output_text;
  if (!Array.isArray(value.output)) return "";
  return value.output.flatMap((item) => isObject(item) && item.type === "message"
    ? messageContentText(item.content)
    : []).join("");
}

export function getStreamResponseCaptureMetadata(value: unknown): CapturedStreamResponse[typeof CAPTURE_METADATA] | null {
  if (typeof value !== "object" || value === null || !(CAPTURE_METADATA in value)) return null;
  return (value as CapturedStreamResponse)[CAPTURE_METADATA];
}

export function createStreamResponseCapture(maxBytes: number): StreamResponseCapture {
  let buffer = "";
  let originalBytes = 0;
  let outputText = "";
  let outputPriority = Number.POSITIVE_INFINITY;
  let contentTruncated = false;
  let toolTruncated = false;
  const tools = new Map<string, ToolState>();
  const anthropicIndexes = new Map<number, string>();
  let generatedToolId = 0;

  const appendText = (priority: number, text: string): void => {
    if (!text || priority > outputPriority) return;
    if (priority < outputPriority) {
      outputPriority = priority;
      outputText = "";
      contentTruncated = false;
    }
    const remaining = Math.max(0, maxBytes - Buffer.byteLength(outputText));
    const retained = utf8Prefix(text, remaining);
    outputText += retained;
    if (retained !== text) contentTruncated = true;
  };

  const recordTool = (id: string, name: string, status: string): void => {
    const safeName = utf8Prefix(name || "工具", MAX_TOOL_NAME_BYTES);
    const existing = tools.get(id);
    if (existing) {
      existing.name = safeName || existing.name;
      existing.status = status;
      return;
    }
    if (tools.size >= MAX_TOOL_ACTIVITIES) {
      toolTruncated = true;
      return;
    }
    tools.set(id, { id, name: safeName || "工具", status });
  };

  const observeTools = (event: string, data: Record<string, unknown>): void => {
    if ((event === "response.output_item.added" || event === "response.output_item.done") && isObject(data.item)) {
      const item = data.item;
      if (item.type === "custom_tool_call" || item.type === "function_call") {
        const id = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : `response-${generatedToolId++}`;
        const fn = isObject(item.function) ? item.function : null;
        const name = typeof item.name === "string" ? item.name : fn && typeof fn.name === "string" ? fn.name : "工具";
        const completed = event.endsWith(".done") || item.status === "completed";
        recordTool(id, name, completed ? "已完成" : "进行中");
      }
    }
    if (event === "content_block_start" && isObject(data.content_block) && data.content_block.type === "tool_use") {
      const index = typeof data.index === "number" ? data.index : generatedToolId++;
      const id = typeof data.content_block.id === "string" ? data.content_block.id : `anthropic-${index}`;
      anthropicIndexes.set(index, id);
      recordTool(id, typeof data.content_block.name === "string" ? data.content_block.name : "工具", "进行中");
    }
    if (event === "content_block_stop") {
      const id = anthropicIndexes.get(typeof data.index === "number" ? data.index : -1);
      const existing = id ? tools.get(id) : undefined;
      if (existing) existing.status = "已完成";
    }
    if (Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (!isObject(choice) || !isObject(choice.delta) || !Array.isArray(choice.delta.tool_calls)) continue;
        choice.delta.tool_calls.forEach((tool, index) => {
          if (!isObject(tool)) return;
          const fn = isObject(tool.function) ? tool.function : null;
          if (!fn || typeof fn.name !== "string") return;
          const toolIndex = typeof tool.index === "number" ? tool.index : index;
          const id = typeof tool.id === "string" ? tool.id : `openai-${toolIndex}`;
          recordTool(id, fn.name, "已完成");
        });
      }
    }
    if (Array.isArray(data.candidates)) {
      for (const candidate of data.candidates) {
        if (!isObject(candidate) || !isObject(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
        for (const part of candidate.content.parts) {
          if (!isObject(part) || !isObject(part.functionCall)) continue;
          const call = part.functionCall;
          const id = typeof call.id === "string" ? call.id : `gemini-${generatedToolId++}`;
          recordTool(id, typeof call.name === "string" ? call.name : "工具", "已完成");
        }
      }
    }
  };

  const observeEvent = (sseEvent: string | undefined, rawData: string): void => {
    if (!rawData || rawData === "[DONE]") return;
    let parsed: unknown;
    try { parsed = JSON.parse(rawData); } catch { return; }
    if (!isObject(parsed)) return;
    const event = sseEvent || (typeof parsed.type === "string" ? parsed.type : "");
    observeTools(event, parsed);

    if (event === "response.output_text.delta" && typeof parsed.delta === "string") {
      appendText(10, parsed.delta);
      return;
    }
    if (event === "content_block_delta" && isObject(parsed.delta)
      && parsed.delta.type === "text_delta" && typeof parsed.delta.text === "string") {
      appendText(10, parsed.delta.text);
      return;
    }
    if (Array.isArray(parsed.choices)) {
      for (const choice of parsed.choices) {
        if (!isObject(choice) || !isObject(choice.delta)) continue;
        if (typeof choice.delta.content === "string") appendText(20, choice.delta.content);
      }
      return;
    }
    if (Array.isArray(parsed.candidates)) {
      for (const candidate of parsed.candidates) {
        if (!isObject(candidate) || !isObject(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
        for (const part of candidate.content.parts) {
          if (isObject(part) && part.thought !== true && typeof part.text === "string") appendText(30, part.text);
        }
      }
      return;
    }
    if (event === "item/agentMessage/delta" && isObject(parsed.params) && typeof parsed.params.delta === "string") {
      appendText(40, parsed.params.delta);
      return;
    }
    if (event === "response.output_text.done" && typeof parsed.text === "string") {
      appendText(50, parsed.text);
      return;
    }
    if (event === "response.completed") {
      appendText(51, completedResponseText(parsed.response));
      return;
    }
    if (event === "response.output_item.done" && isObject(parsed.item) && parsed.item.type === "message") {
      appendText(60, messageContentText(parsed.item.content).join(""));
    }
  };

  const observeBlock = (block: string): void => {
    if (!block || block.startsWith(":")) return;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    observeEvent(event, dataLines.join("\n"));
  };

  const drain = (flush = false): void => {
    buffer = buffer.replace(/\r\n/g, "\n");
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      observeBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
    if (flush && buffer.trim()) {
      observeBlock(buffer.replace(/\r$/, ""));
      buffer = "";
    }
  };

  return {
    appendWrittenChunk(chunk) {
      originalBytes += Buffer.byteLength(chunk);
      buffer += chunk;
      drain();
    },
    finish() {
      drain(true);
      const activities = Array.from(tools.values(), ({ name, status }) => ({ name, status }));
      const payload = serializeDisplayPayload("output", outputText.trim(), maxBytes, originalBytes, activities);
      const value = JSON.parse(payload.json) as Record<string, unknown>;
      const truncated = contentTruncated || toolTruncated || payload.truncated;
      Object.defineProperty(value, CAPTURE_METADATA, {
        value: { originalBytes, truncated },
      });
      return value;
    },
  };
}
