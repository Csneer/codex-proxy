import { describe, expect, it, vi } from "vitest";
import {
  createMailDashboardClient,
  MailDashboardError,
} from "@src/services/mail-dashboard-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MailDashboardClient", () => {
  it("allows an 11-second response within the 30-second request timeout", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), delay);
      return controller.signal;
    });
    const request = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((resolve, reject) => {
      const responseTimer = setTimeout(() => resolve(jsonResponse({ emails: [] })), 11_000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(responseTimer);
        reject(new Error("request aborted"));
      }, { once: true });
    }));
    const client = createMailDashboardClient("http://127.0.0.1:4173", request);

    try {
      const result = client.listMailboxes();
      await vi.advanceTimersByTimeAsync(11_000);

      await expect(result).resolves.toEqual([]);
      expect(timeout).toHaveBeenCalledWith(30_000);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
  it("normalizes usable mailbox records and omits malformed entries", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      emails: [
        { email: "  FIRST@EXAMPLE.COM ", appleLabel: "Primary", group: "unused", registrationEligible: true },
        { email: "second@example.com", label: "Fallback label", group: "finished", registrationEligible: false },
        { email: "" },
        { label: "missing email" },
        null,
      ],
    }));
    const client = createMailDashboardClient("http://127.0.0.1:4173/", request);

    await expect(client.listMailboxes()).resolves.toEqual([
      {
        email: "first@example.com",
        externalId: "first@example.com",
        sourceRevision: "first@example.com:Primary:unused:eligible",
        appleLabel: "Primary",
        registrationEligible: true,
      },
      {
        email: "second@example.com",
        externalId: "second@example.com",
        sourceRevision: "second@example.com:Fallback label:finished:blocked",
        appleLabel: "Fallback label",
        registrationEligible: false,
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/api/icloud/list",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("returns only a fresh verification code for the requested mailbox", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      updates: [
        { email: "other@example.com", code: "999999", receivedAt: "2026-08-09T07:02:00.000Z" },
        { email: "USER@example.com", code: "123456", receivedAt: "2026-08-09T07:01:00.000Z" },
      ],
    }));
    const client = createMailDashboardClient("http://127.0.0.1:4173", request);

    await expect(client.pollVerificationCode("user@example.com", "2026-08-09T07:00:00.000Z"))
      .resolves.toEqual({ status: "received", code: "123456", receivedAt: "2026-08-09T07:01:00.000Z" });
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:4173/api/forward/check",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accounts: [{ email: "user@example.com", lastReceivedAt: "2026-08-09T07:00:00.000Z", force: false }],
        }),
      }),
    );
  });

  it("accepts an IMAP timestamp up to two seconds behind the watermark", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        updates: [{ email: "user@example.com", code: "123456", receivedAt: "2026-08-09T07:00:00.000Z" }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        updates: [{ email: "user@example.com", code: "123456", receivedAt: "2026-08-09T07:00:00.000Z" }],
      }));
    const client = createMailDashboardClient("http://127.0.0.1:4173", request);

    await expect(client.pollVerificationCode("user@example.com", "2026-08-09T07:00:02.000Z"))
      .resolves.toEqual({ status: "received", code: "123456", receivedAt: "2026-08-09T07:00:00.000Z" });
    await expect(client.pollVerificationCode("user@example.com", "2026-08-09T07:00:02.001Z"))
      .resolves.toEqual({ status: "pending" });
  });

  it("treats stale, malformed, or missing verification updates as pending", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        updates: [{ email: "user@example.com", code: "123456", receivedAt: "2026-08-09T06:59:56.000Z" }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        updates: [{ email: "user@example.com", code: "", receivedAt: "2026-08-09T07:01:00.000Z" }],
      }))
      .mockResolvedValueOnce(jsonResponse({ updates: [] }));
    const client = createMailDashboardClient("http://127.0.0.1:4173", request);

    await expect(client.pollVerificationCode("user@example.com", "2026-08-09T07:00:00.000Z"))
      .resolves.toEqual({ status: "pending" });
    await expect(client.pollVerificationCode("user@example.com", "2026-08-09T07:00:00.000Z"))
      .resolves.toEqual({ status: "pending" });
    await expect(client.pollVerificationCode("user@example.com", "2026-08-09T07:00:00.000Z"))
      .resolves.toEqual({ status: "pending" });
  });

  it("redacts malformed, non-success, and transport failures as MailDashboardError", async () => {
    const malformed = createMailDashboardClient(
      "http://127.0.0.1:4173",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ unexpected: [] })),
    );
    const unavailable = createMailDashboardClient(
      "http://127.0.0.1:4173",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "internal detail" }, 503)),
    );
    const rejected = createMailDashboardClient(
      "http://127.0.0.1:4173",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("connection detail")),
    );

    await expect(malformed.listMailboxes()).rejects.toBeInstanceOf(MailDashboardError);
    await expect(unavailable.listMailboxes()).rejects.toBeInstanceOf(MailDashboardError);
    await expect(rejected.listMailboxes()).rejects.toBeInstanceOf(MailDashboardError);
  });
});
