type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function textFromContent(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textFromContent);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (typeof object.text === "string") return [object.text];
  if (typeof object.input_text === "string") return [object.input_text];
  return textFromContent(object.content);
}

function messageText(value: unknown, role?: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => messageText(item, role));
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const nextRole = typeof object.role === "string" ? object.role : role;
  if (nextRole === "user") {
    const content = textFromContent(object.content ?? object.input ?? object.message);
    if (content.length > 0) return content;
  }
  if (object.type === "input_text" && typeof object.text === "string") return [object.text];
  if (Array.isArray(object.input)) return messageText(object.input, nextRole);
  if (Array.isArray(object.messages)) return messageText(object.messages, nextRole);
  return [];
}

export function extractInputText(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
  const object = value as Record<string, unknown>;
  const text = messageText(object.input ?? object.messages ?? object.prompt ?? object, undefined);
  return text.join("\n").trim();
}

function outputEventText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(outputEventText);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const event = typeof object.event === "string" ? object.event : "";
  const data = object.data && typeof object.data === "object" ? object.data as Record<string, unknown> : object;
  if (event.endsWith("output_text.delta") && typeof data.delta === "string") return [data.delta];
  if (typeof data.delta === "string") return [data.delta];
  if (typeof data.text === "string") return [data.text];
  const response = data.response && typeof data.response === "object" ? data.response as Record<string, unknown> : data;
  const output = response.output;
  if (Array.isArray(output)) return output.flatMap((item) => textFromContent((item as Record<string, unknown>)?.content));
  return [];
}

export function extractOutputText(value: unknown): string {
  return outputEventText(value).join("").trim();
}

export function parseStoredJson(value: string): JsonValue | string {
  try { return JSON.parse(value) as JsonValue; } catch { return value; }
}
