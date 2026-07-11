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
      events.push(event ? { event, data } : { data });
    }
  };

  return {
    appendWrittenChunk(chunk) {
      buffer += chunk.replace(/\r\n/g, "\n");
      drain();
    },
    finish() {
      drain();
      const bounded = serializeBounded(events, maxBytes);
      const value = bounded.truncated
        ? { truncated: true, original_bytes: bounded.originalBytes, events: JSON.parse(bounded.json) }
        : events;
      Object.defineProperty(value, CAPTURE_METADATA, {
        value: { originalBytes: bounded.originalBytes, truncated: bounded.truncated },
      });
      return value;
    },
  };
}
