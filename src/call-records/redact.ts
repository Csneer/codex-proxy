export interface BoundedJson {
  json: string;
  originalBytes: number;
  truncated: boolean;
}

const REDACTED = "[REDACTED]";
const REDACTED_EMAIL = "[REDACTED_EMAIL]";
const REDACTED_TOKEN = "[REDACTED_TOKEN]";
const SECRET_KEY_RE = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|session[_-]?token|jwt|password|passwd|secret|client[_-]?secret|shared[_-]?secret|oauth[_-]?(?:token|secret)|credential|credentials)$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BEARER_RE = /^Bearer\s+[A-Za-z0-9._~+/=-]{16,}$/i;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const API_KEY_RE = /^(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{20,}$/i;
const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BINARY_MIN_BYTES = 1024;

interface BinaryMarker {
  redacted_binary: true;
  media_type: string;
  bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binaryMarker(mediaType: string, encoded: string): BinaryMarker | null {
  const normalized = encoded.replace(/\s/g, "");
  if (!BASE64_RE.test(normalized) || normalized.length % 4 !== 0) return null;
  const bytes = Buffer.from(normalized, "base64").byteLength;
  if (bytes < BINARY_MIN_BYTES) return null;
  return { redacted_binary: true, media_type: mediaType, bytes };
}

function redactString(value: string): string | BinaryMarker {
  const dataUrl = DATA_URL_RE.exec(value);
  if (dataUrl) {
    const marker = binaryMarker(dataUrl[1], dataUrl[2]);
    if (marker) return marker;
  }
  if (EMAIL_RE.test(value)) return REDACTED_EMAIL;
  if (BEARER_RE.test(value) || JWT_RE.test(value) || API_KEY_RE.test(value)) return REDACTED_TOKEN;
  return value;
}

function redact(value: unknown, parentMediaType?: string, key?: string, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    if (key && SECRET_KEY_RE.test(key)) return REDACTED;
    if (key && /^(?:data|b64_json|base64|image_data)$/i.test(key)) {
      return binaryMarker(parentMediaType ?? "application/octet-stream", value) ?? redactString(value);
    }
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => redact(item, parentMediaType, undefined, seen));
    seen.delete(value);
    return result;
  }

  const record = value as Record<string, unknown>;
  const mediaType = typeof record.media_type === "string"
    ? record.media_type
    : typeof record.mime_type === "string"
      ? record.mime_type
      : parentMediaType;
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(record)) {
    result[entryKey] = SECRET_KEY_RE.test(entryKey)
      ? REDACTED
      : redact(entryValue, mediaType, entryKey, seen);
  }
  seen.delete(value);
  return result;
}

export function redactCallContent(value: unknown): unknown {
  return redact(value);
}

function compactLargeValues(value: unknown): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    return bytes > 256 ? { truncated: true, original_bytes: bytes } : value;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, 16).map(compactLargeValues);
    if (kept.length < value.length) {
      kept.push({ truncated: true, omitted_items: value.length - kept.length });
    }
    return kept;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      compactLargeValues(entryValue),
    ]));
  }
  return value;
}

export function serializeBounded(value: unknown, maxBytes: number): BoundedJson {
  const json = JSON.stringify(value) ?? "null";
  const originalBytes = Buffer.byteLength(json);
  if (originalBytes <= maxBytes) return { json, originalBytes, truncated: false };

  const compactedValue = compactLargeValues(value);
  const compacted = JSON.stringify(isRecord(compactedValue)
    ? { ...compactedValue, truncated: true, original_bytes: originalBytes }
    : { value: compactedValue, truncated: true, original_bytes: originalBytes });
  if (Buffer.byteLength(compacted) <= maxBytes) {
    return { json: compacted, originalBytes, truncated: true };
  }

  const marker = JSON.stringify({ truncated: true, original_bytes: originalBytes });
  if (Buffer.byteLength(marker) > maxBytes) {
    throw new RangeError("maxBytes is too small for a valid truncation marker");
  }
  return { json: marker, originalBytes, truncated: true };
}
