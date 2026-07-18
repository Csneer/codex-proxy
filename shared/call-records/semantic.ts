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

function outputContentText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(outputContentText);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type : "";
  if ((type === "output_text" || type === "text") && typeof object.text === "string") return [object.text];
  if (Array.isArray(object.content)) return object.content.flatMap(outputContentText);
  return [];
}

function responseObjectText(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (object.data && typeof object.data === "object" && !Array.isArray(object.data)) {
    const wrapped = responseObjectText(object.data);
    if (wrapped.length > 0) return wrapped;
  }
  if (typeof object.output_text === "string") return [object.output_text];
  if (typeof object.text === "string") return [object.text];
  if (Array.isArray(object.output)) return object.output.flatMap(outputContentText);
  if (Array.isArray(object.content)) return object.content.flatMap(outputContentText);
  if (Array.isArray(object.candidates)) {
    return object.candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const content = (candidate as Record<string, unknown>).content;
      if (!content || typeof content !== "object") return [];
      const parts = (content as Record<string, unknown>).parts;
      if (!Array.isArray(parts)) return [];
      return parts.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? [text] : [];
      });
    });
  }
  if (Array.isArray(object.choices)) {
    return object.choices.flatMap((choice) => {
      if (!choice || typeof choice !== "object") return [];
      const message = (choice as Record<string, unknown>).message;
      if (!message || typeof message !== "object") return [];
      return outputContentText((message as Record<string, unknown>).content);
    });
  }
  return [];
}

function outputEventText(value: unknown): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const wrapper = value as Record<string, unknown>;
    if (Array.isArray(wrapper.events)) return outputEventText(wrapper.events);
  }
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return responseObjectText(value);
  const deltas: string[] = [];
  const completed: string[] = [];
  const itemTexts: string[] = [];
  const responseTexts: string[] = [];
  const openAiDeltas: string[] = [];
  const geminiDeltas: string[] = [];
  const officialAgentDeltas: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const object = entry as Record<string, unknown>;
    const event = typeof object.event === "string" ? object.event : "";
    const data = object.data && typeof object.data === "object" ? object.data as Record<string, unknown> : object;
    if (!event && Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (!choice || typeof choice !== "object") continue;
        const delta = (choice as Record<string, unknown>).delta;
        if (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).content === "string") {
          openAiDeltas.push((delta as Record<string, unknown>).content as string);
        }
      }
      continue;
    }
    if (!event && Array.isArray(data.candidates)) {
      for (const candidate of data.candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const content = (candidate as Record<string, unknown>).content;
        if (!content || typeof content !== "object") continue;
        const parts = (content as Record<string, unknown>).parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
            geminiDeltas.push((part as Record<string, unknown>).text as string);
          }
        }
      }
      continue;
    }
    if (event === "item/agentMessage/delta") {
      const params = data.params;
      if (params && typeof params === "object" && typeof (params as Record<string, unknown>).delta === "string") {
        officialAgentDeltas.push((params as Record<string, unknown>).delta as string);
      }
      continue;
    }
    if (event === "response.output_text.delta" && typeof data.delta === "string") {
      deltas.push(data.delta);
      continue;
    }
    if (event === "content_block_delta" && data.delta && typeof data.delta === "object") {
      const delta = data.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") deltas.push(delta.text);
      continue;
    }
    if (event === "response.output_text.done" && typeof data.text === "string") {
      completed.push(data.text);
      continue;
    }
    if (event === "response.output_item.done") {
      const item = data.item;
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === "message") {
        itemTexts.push(...outputContentText((item as Record<string, unknown>).content));
      }
      continue;
    }
    if (event === "response.completed") {
      responseTexts.push(...responseObjectText(data.response));
    }
  }
  if (deltas.length > 0) return deltas;
  if (openAiDeltas.length > 0) return openAiDeltas;
  if (geminiDeltas.length > 0) return geminiDeltas;
  if (officialAgentDeltas.length > 0) return officialAgentDeltas;
  if (completed.length > 0) return completed;
  if (itemTexts.length > 0) return itemTexts;
  return responseTexts;
}

export function extractOutputText(value: unknown): string {
  return outputEventText(value).join("").trim();
}

export interface ToolActivity {
  name: string;
  status: string;
}

export function extractToolActivities(value: unknown): ToolActivity[] {
  const objectValue = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const unwrappedObject = objectValue?.data && typeof objectValue.data === "object" && !Array.isArray(objectValue.data)
    ? objectValue.data as Record<string, unknown>
    : objectValue;
  const entries = unwrappedObject
    ? (Array.isArray(unwrappedObject.events)
      ? unwrappedObject.events
      : Array.isArray(unwrappedObject.output)
        ? unwrappedObject.output
        : Array.isArray(unwrappedObject.content)
          ? unwrappedObject.content
          : [unwrappedObject])
    : value;
  if (!Array.isArray(entries)) return [];
  const activities = new Map<string, ToolActivity>();
  const anthropicIndexes = new Map<number, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const object = entry as Record<string, unknown>;
    if (object.event === "content_block_start") {
      const data = object.data && typeof object.data === "object" ? object.data as Record<string, unknown> : object;
      const block = data.content_block && typeof data.content_block === "object" ? data.content_block as Record<string, unknown> : null;
      if (block?.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : `anthropic-${String(data.index ?? activities.size)}`;
        const index = typeof data.index === "number" ? data.index : activities.size;
        anthropicIndexes.set(index, id);
        activities.set(id, { name: typeof block.name === "string" ? block.name : "工具", status: "进行中" });
      }
      continue;
    }
    if (object.event === "content_block_stop") {
      const data = object.data && typeof object.data === "object" ? object.data as Record<string, unknown> : object;
      const id = anthropicIndexes.get(typeof data.index === "number" ? data.index : -1);
      if (id) {
        const current = activities.get(id);
        if (current) current.status = "已完成";
      }
      continue;
    }
    const isResponseToolEvent = object.event === "response.output_item.added" || object.event === "response.output_item.done";
    const isResponseToolItem = object.type === "custom_tool_call" || object.type === "function_call";
    const isAnthropicToolItem = object.type === "tool_use";
    if (isAnthropicToolItem) {
      const id = typeof object.id === "string" ? object.id : `anthropic-${String(activities.size)}`;
      activities.set(id, {
        name: typeof object.name === "string" ? object.name : "工具",
        status: "已完成",
      });
      continue;
    }
    if (object.type === "function" && typeof object.name === "string") {
      const id = typeof object.id === "string" ? object.id : `function-${String(activities.size)}`;
      activities.set(id, { name: object.name, status: "已完成" });
      continue;
    }
    if (object.functionCall && typeof object.functionCall === "object") {
      const functionCall = object.functionCall as Record<string, unknown>;
      const name = typeof functionCall.name === "string" ? functionCall.name : "工具";
      const id = typeof functionCall.id === "string" ? functionCall.id : `gemini-${String(activities.size)}`;
      activities.set(id, { name, status: "已完成" });
      continue;
    }
    if (Array.isArray(object.candidates)) {
      for (const candidate of object.candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const content = (candidate as Record<string, unknown>).content;
        if (!content || typeof content !== "object") continue;
        const parts = (content as Record<string, unknown>).parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const functionCall = (part as Record<string, unknown>).functionCall;
          if (!functionCall || typeof functionCall !== "object") continue;
          const call = functionCall as Record<string, unknown>;
          const name = typeof call.name === "string" ? call.name : "工具";
          const id = typeof call.id === "string" ? call.id : `gemini-${String(activities.size)}`;
          activities.set(id, { name, status: "已完成" });
        }
      }
      continue;
    }
    if (Array.isArray(object.choices)) {
      for (const choice of object.choices) {
        if (!choice || typeof choice !== "object") continue;
        const message = (choice as Record<string, unknown>).message;
        if (!message || typeof message !== "object") continue;
        const toolCalls = (message as Record<string, unknown>).tool_calls;
        if (!Array.isArray(toolCalls)) continue;
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== "object") continue;
          const call = toolCall as Record<string, unknown>;
          const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
          if (!fn || typeof fn.name !== "string") continue;
          const id = typeof call.id === "string" ? call.id : `openai-${String(activities.size)}`;
          activities.set(id, { name: fn.name, status: "已完成" });
        }
      }
      continue;
    }
    if (!isResponseToolEvent && !isResponseToolItem) continue;
    const data = object.data && typeof object.data === "object" ? object.data as Record<string, unknown> : object;
    const item = isResponseToolItem
      ? object
      : data.item && typeof data.item === "object" ? data.item as Record<string, unknown> : null;
    if (!item || (item.type !== "custom_tool_call" && item.type !== "function_call")) continue;
    const id = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : "";
    if (!id) continue;
    const current = activities.get(id) ?? { name: typeof item.name === "string" ? item.name : "工具", status: "进行中" };
    if (typeof item.name === "string" && item.name) current.name = item.name;
    if (typeof item.status === "string") current.status = item.status === "completed" ? "已完成" : item.status;
    activities.set(id, current);
  }
  return Array.from(activities.values());
}

export function parseStoredJson(value: string): JsonValue | string {
  try { return JSON.parse(value) as JsonValue; } catch { return value; }
}
