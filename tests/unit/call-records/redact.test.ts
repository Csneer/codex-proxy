import { describe, expect, it } from "vitest";
import { redactCallContent, serializeBounded } from "@src/call-records/redact.js";

describe("redactCallContent", () => {
  it("recursively redacts secret keys and sensitive string shapes", () => {
    const value = redactCallContent({
      authorization: "Bearer top-secret",
      headers: { cookie: "sid=secret", "x-api-key": "sk-header-secret" },
      extraHeaders: {
        "x-auth-token": "auth-secret",
        "x_goog_api_key": "google-secret",
      },
      nested: {
        api_key: "sk-api-secret",
        access_token: "access-secret",
        refreshToken: "refresh-secret",
        token: "generic-secret",
        password: "hunter2",
        owner: "person@example.com",
        bearerInText: "Bearer abcdefghijklmnopqrstuvwxyz012345",
        jwtInText: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturevalue",
        apiKeyInText: "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
        github_token: "github-secret",
        "private-key": "private-secret",
        prose: "Contact person@example.com about ordinary token usage analysis.",
      },
      prompt: "Explain why token usage rose yesterday.",
    });

    expect(value).toEqual({
      authorization: "[REDACTED]",
      headers: { cookie: "[REDACTED]", "x-api-key": "[REDACTED]" },
      extraHeaders: {
        "x-auth-token": "[REDACTED]",
        "x_goog_api_key": "[REDACTED]",
      },
      nested: {
        api_key: "[REDACTED]",
        access_token: "[REDACTED]",
        refreshToken: "[REDACTED]",
        token: "[REDACTED]",
        password: "[REDACTED]",
        owner: "[REDACTED_EMAIL]",
        bearerInText: "[REDACTED_TOKEN]",
        jwtInText: "[REDACTED_TOKEN]",
        apiKeyInText: "[REDACTED_TOKEN]",
        github_token: "[REDACTED]",
        "private-key": "[REDACTED]",
        prose: "Contact [REDACTED_EMAIL] about ordinary token usage analysis.",
      },
      prompt: "Explain why token usage rose yesterday.",
    });
  });

  it("replaces large data URLs and base64 payload fields with metadata", () => {
    const raw = Buffer.alloc(4096, 7);
    const base64 = raw.toString("base64");

    expect(redactCallContent({ image_url: `data:image/png;base64,${base64}` })).toEqual({
      image_url: { redacted_binary: true, media_type: "image/png", bytes: 4096 },
    });
    expect(redactCallContent({ media_type: "image/png", data: base64 })).toEqual({
      media_type: "image/png",
      data: { redacted_binary: true, media_type: "image/png", bytes: 4096 },
    });
    expect(redactCallContent({ b64_json: base64 })).toEqual({
      b64_json: { redacted_binary: true, media_type: "application/octet-stream", bytes: 4096 },
    });
  });
});

describe("serializeBounded", () => {
  it("returns untruncated valid JSON and its original byte length", () => {
    const result = serializeBounded({ prompt: "你好" }, 1024);

    expect(result.truncated).toBe(false);
    expect(result.originalBytes).toBe(Buffer.byteLength(JSON.stringify({ prompt: "你好" })));
    expect(JSON.parse(result.json)).toEqual({ prompt: "你好" });
  });

  it("bounds large bodies without cutting UTF-8 or producing invalid JSON", () => {
    const value = { prompt: "🙂汉字".repeat(1000), small: "kept when possible" };
    const originalBytes = Buffer.byteLength(JSON.stringify(value));
    const result = serializeBounded(value, 1024);

    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(originalBytes);
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(1024);
    expect(JSON.parse(result.json)).toMatchObject({ truncated: true, original_bytes: originalBytes });
    expect(result.json).not.toContain("�");
  });
});
