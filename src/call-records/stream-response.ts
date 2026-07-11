import { serializeBounded } from "./redact.js";

export interface StreamResponseCapture {
  appendWrittenChunk(chunk: string): void;
  finish(): unknown;
}

const CAPTURE_METADATA = Symbol("call-record-stream-capture");

interface CapturedStreamResponse {
  [CAPTURE_METADATA]: {
    originalBytes: number;
    truncated: boolean;
  };
}

export function getStreamResponseCaptureMetadata(value: unknown): CapturedStreamResponse[typeof CAPTURE_METADATA] | null {
  if (typeof value !== "object" || value === null || !(CAPTURE_METADATA in value)) return null;
  return (value as CapturedStreamResponse)[CAPTURE_METADATA];
}

export function createStreamResponseCapture(maxBytes: number): StreamResponseCapture {
  let buffer = "";
  const events: Array<{ event?: string; data: unknown }> = [];
  let totalEvents = 0;
  let originalBytes = 2;
  let retainedBytes = 2;
  let omittedEvents = 0;
  let overflowed = false;

  const observeEvent = (value: { event?: string; data: unknown }): void => {
    const eventBytes = Buffer.byteLength(JSON.stringify(value));
    originalBytes += eventBytes + (totalEvents > 0 ? 1 : 0);
    totalEvents++;
    if (overflowed || retainedBytes + eventBytes + (events.length > 0 ? 1 : 0) > maxBytes) {
      overflowed = true;
      omittedEvents++;
      return;
    }
    events.push(value);
    retainedBytes += eventBytes + (events.length > 1 ? 1 : 0);
  };

  const drain = (): void => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) return;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!block || block.startsWith(":")) continue;
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      const raw = dataLines.join("\n");
      if (!raw || raw === "[DONE]") continue;
      let data: unknown = raw;
      try { data = JSON.parse(raw); } catch { /* retain text */ }
      observeEvent(event ? { event, data } : { data });
    }
  };

  return {
    appendWrittenChunk(chunk) {
      buffer += chunk.replace(/\r\n/g, "\n");
      drain();
    },
    finish() {
      drain();
      let value: unknown = events;
      let truncated = omittedEvents > 0;
      if (truncated) {
        let retainedEvents = events;
        let wrapper = { truncated: true, original_bytes: originalBytes, omitted_events: omittedEvents, events: retainedEvents };
        while (retainedEvents.length > 0 && Buffer.byteLength(JSON.stringify(wrapper)) > maxBytes) {
          retainedEvents = retainedEvents.slice(0, -1);
          omittedEvents++;
          wrapper = { truncated: true, original_bytes: originalBytes, omitted_events: omittedEvents, events: retainedEvents };
        }
        value = wrapper;
      } else {
        const bounded = serializeBounded(events, maxBytes);
        if (bounded.truncated) {
          truncated = true;
          value = { truncated: true, original_bytes: bounded.originalBytes, omitted_events: 0, events: JSON.parse(bounded.json) };
        }
      }
      Object.defineProperty(value, CAPTURE_METADATA, {
        value: { originalBytes, truncated },
      });
      return value;
    },
  };
}
