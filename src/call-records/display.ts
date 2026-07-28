export interface DisplayPayload {
  json: string;
  originalBytes: number;
  truncated: boolean;
}

export interface DisplayToolActivity {
  name: string;
  status: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (!isObject(value)) return [];
  if (typeof value.text === "string") return [value.text];
  if (typeof value.input_text === "string") return [value.input_text];
  if (typeof value.output_text === "string") return [value.output_text];
  return textValues(value.content ?? value.parts);
}

function inputValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(inputValues);
  if (!isObject(value)) return [];
  if (typeof value.input_text === "string") return [value.input_text];
  if (value.role === "user") {
    const userText = textValues(value.content ?? value.input ?? value.message ?? value.parts);
    if (userText.length > 0) return userText;
  }
  if (value.type === "input_text" && typeof value.text === "string") return [value.text];
  for (const key of ["input", "messages", "prompt", "contents"]) {
    if (key in value) {
      const nested = inputValues(value[key]);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

export function extractDisplayInput(value: unknown): string {
  const extracted = inputValues(value);
  if (extracted.length > 0) return extracted.join("\n").trim();
  return isObject(value) && typeof value.text === "string" ? value.text.trim() : "";
}

function visibleContentText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(visibleContentText);
  if (!isObject(value)) return [];
  const type = typeof value.type === "string" ? value.type : "";
  if (value.thought === true || ["thinking", "reasoning", "tool_use", "function_call", "custom_tool_call"].includes(type)) return [];
  if ((!type || type === "text" || type === "output_text") && typeof value.text === "string") return [value.text];
  return visibleContentText(value.content ?? value.parts);
}

function outputValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!isObject(value)) return [];
  if (typeof value.output_text === "string") return [value.output_text];
  if (isObject(value.data)) {
    const nested = outputValues(value.data);
    if (nested.length > 0) return nested;
  }
  if (isObject(value.response)) {
    const nested = outputValues(value.response);
    if (nested.length > 0) return nested;
  }
  if (Array.isArray(value.output)) {
    const nested = value.output.flatMap((item) => isObject(item) && item.type === "message"
      ? visibleContentText(item.content)
      : []);
    if (nested.length > 0) return nested;
  }
  if (Array.isArray(value.choices)) {
    const nested = value.choices.flatMap((choice) => {
      if (!isObject(choice)) return [];
      const message = isObject(choice.message) ? choice.message : isObject(choice.delta) ? choice.delta : null;
      return message ? visibleContentText(message.content) : [];
    });
    if (nested.length > 0) return nested;
  }
  if (Array.isArray(value.candidates)) {
    const nested = value.candidates.flatMap((candidate) => isObject(candidate) && isObject(candidate.content)
      ? visibleContentText(candidate.content.parts)
      : []);
    if (nested.length > 0) return nested;
  }
  if (typeof value.params === "object" && value.params !== null && typeof (value.params as Record<string, unknown>).delta === "string") {
    return [(value.params as Record<string, unknown>).delta as string];
  }
  if (Array.isArray(value.content)) return visibleContentText(value.content);
  const type = typeof value.type === "string" ? value.type : "";
  return (!type || type === "text" || type === "output_text") && typeof value.text === "string" ? [value.text] : [];
}

export function extractDisplayOutput(value: unknown): string {
  if (Array.isArray(value)) {
    const deltas: string[] = [];
    const completed: string[] = [];
    const itemTexts: string[] = [];
    const openAi: string[] = [];
    const gemini: string[] = [];
    const official: string[] = [];
    for (const entry of value) {
      if (!isObject(entry)) continue;
      const event = typeof entry.event === "string" ? entry.event : "";
      const data = isObject(entry.data) ? entry.data : entry;
      if (!event && Array.isArray(data.choices)) {
        openAi.push(...data.choices.flatMap((choice) => isObject(choice) && isObject(choice.delta) && typeof choice.delta.content === "string" ? [choice.delta.content] : []));
      } else if (!event && Array.isArray(data.candidates)) {
        gemini.push(...data.candidates.flatMap((candidate) => isObject(candidate) && isObject(candidate.content) && Array.isArray(candidate.content.parts)
          ? visibleContentText(candidate.content.parts)
          : []));
      } else if (event === "response.output_text.delta" && typeof data.delta === "string") deltas.push(data.delta);
      else if (event === "content_block_delta" && isObject(data.delta) && data.delta.type === "text_delta" && typeof data.delta.text === "string") deltas.push(data.delta.text);
      else if (event === "item/agentMessage/delta" && isObject(data.params) && typeof data.params.delta === "string") official.push(data.params.delta);
      else if (event === "response.output_text.done" && typeof data.text === "string") completed.push(data.text);
      else if (event === "response.output_item.done" && isObject(data.item) && data.item.type === "message") itemTexts.push(...visibleContentText(data.item.content));
      else if (event === "response.completed" && isObject(data.response)) completed.push(...outputValues(data.response));
    }
    const selected = deltas.length > 0 ? deltas : openAi.length > 0 ? openAi : gemini.length > 0 ? gemini : official.length > 0 ? official : completed.length > 0 ? completed : itemTexts;
    return selected.join("").trim();
  }
  return outputValues(value).join("").trim();
}

export function extractDisplayTools(value: unknown): DisplayToolActivity[] {
  const found = new Map<string, DisplayToolActivity>();
  const anthropicIndexes = new Map<number, string>();
  let generatedId = 0;

  const statusText = (status: unknown, fallback = "已完成"): string => {
    if (status === "completed" || status === "已完成") return "已完成";
    if (typeof status === "string" && status) return status;
    return fallback;
  };
  const record = (candidate: Record<string, unknown>, fallbackStatus = "已完成", fallbackId?: string): void => {
    const fn = isObject(candidate.function) ? candidate.function : null;
    const name = typeof candidate.name === "string" && candidate.name
      ? candidate.name
      : fn && typeof fn.name === "string" && fn.name
        ? fn.name
        : "工具";
    const id = typeof candidate.id === "string" && candidate.id
      ? candidate.id
      : typeof candidate.call_id === "string" && candidate.call_id
        ? candidate.call_id
        : fallbackId ?? `tool-${generatedId++}`;
    found.set(id, { name, status: statusText(candidate.status, fallbackStatus) });
  };

  const visit = (current: unknown): void => {
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (!isObject(current)) return;

    if (Array.isArray(current.tool_activities)) {
      current.tool_activities.forEach((item, index) => {
        if (isObject(item) && typeof item.name === "string") record(item, "已完成", `stored-${index}-${item.name}`);
      });
    }

    const event = typeof current.event === "string" ? current.event : "";
    const data = isObject(current.data) ? current.data : current;
    if (event === "content_block_start" && isObject(data.content_block) && data.content_block.type === "tool_use") {
      const index = typeof data.index === "number" ? data.index : generatedId++;
      const id = typeof data.content_block.id === "string" ? data.content_block.id : `anthropic-${index}`;
      anthropicIndexes.set(index, id);
      record(data.content_block, "进行中", id);
    } else if (event === "content_block_stop") {
      const index = typeof data.index === "number" ? data.index : -1;
      const id = anthropicIndexes.get(index);
      const activity = id ? found.get(id) : undefined;
      if (activity) activity.status = "已完成";
    }

    if ((event === "response.output_item.added" || event === "response.output_item.done") && isObject(data.item)) {
      const type = data.item.type;
      if (type === "custom_tool_call" || type === "function_call") {
        record(data.item, event.endsWith(".done") ? "已完成" : "进行中");
      }
    }
    if (["custom_tool_call", "function_call", "tool_use"].includes(String(current.type))) record(current);
    if (isObject(current.functionCall)) record(current.functionCall);
    if (isObject(current.function_call)) record(current.function_call);

    if (Array.isArray(current.choices)) {
      for (const choice of current.choices) {
        if (!isObject(choice)) continue;
        for (const container of [choice.message, choice.delta]) {
          if (!isObject(container) || !Array.isArray(container.tool_calls)) continue;
          container.tool_calls.forEach((tool, index) => {
            if (isObject(tool)) record(tool, "已完成", `openai-${index}`);
          });
        }
      }
    }
    if (Array.isArray(current.candidates)) {
      for (const candidate of current.candidates) {
        if (!isObject(candidate) || !isObject(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
        for (const part of candidate.content.parts) {
          if (isObject(part) && isObject(part.functionCall)) record(part.functionCall);
        }
      }
    }

    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
  return Array.from(found.values());
}

export function serializeDisplayPayload(
  kind: "input" | "output",
  text: string,
  maxBytes: number,
  originalBytes: number,
  tools: DisplayToolActivity[] = [],
): DisplayPayload {
  const key = kind === "input" ? "input_text" : "output_text";
  let retainedTools = tools;
  const make = (value: string, includeMarker: boolean, toolActivities = retainedTools): string => JSON.stringify({
    [key]: value,
    ...(toolActivities.length > 0 ? { tool_activities: toolActivities } : {}),
    ...(includeMarker ? { truncated: true, original_bytes: originalBytes } : {}),
  });
  const complete = make(text, false);
  if (Buffer.byteLength(complete) <= maxBytes) return { json: complete, originalBytes, truncated: false };

  while (retainedTools.length > 0 && Buffer.byteLength(make("", true)) > maxBytes) {
    retainedTools = retainedTools.slice(0, -1);
  }

  const safePrefix = (end: number): string => {
    if (end > 0 && end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--;
    }
    return text.slice(0, end);
  };
  let low = 0;
  let high = text.length;
  let best = make("", true);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = make(safePrefix(mid), true);
    if (Buffer.byteLength(candidate) <= maxBytes) { best = candidate; low = mid + 1; } else high = mid - 1;
  }
  return { json: best, originalBytes, truncated: true };
}
