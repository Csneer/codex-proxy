export interface MailboxSourceRecord {
  email: string;
  externalId: string;
  sourceRevision: string;
  appleLabel: string | null;
  registrationEligible?: boolean;
}

export type VerificationCodeResult =
  | { status: "pending" }
  | { status: "received"; code: string; receivedAt: string }
  | { status: "error" };

export interface MailDashboardClient {
  listMailboxes(): Promise<MailboxSourceRecord[]>;
  pollVerificationCode(email: string, after: string): Promise<VerificationCodeResult>;
}

export class MailDashboardError extends Error {
  constructor() {
    super("Mail dashboard is unavailable");
  }
}

type FetchLike = typeof fetch;

export const MAIL_DASHBOARD_REQUEST_TIMEOUT_MS = 30_000;
// IMAP internalDate values have one-second precision.  The mail service can
// therefore report a message timestamp just before the millisecond-precision
// `after` watermark captured immediately before the OTP request.  Keep this
// tolerance limited to a couple of seconds so an actually older challenge is
// still rejected.
export const MAIL_RECEIVED_AT_SKEW_MS = 2_000;

function baseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAfterOrEqual(receivedAt: string, after: string): boolean {
  const receivedAtMs = Date.parse(receivedAt);
  const afterMs = Date.parse(after);
  return Number.isFinite(receivedAtMs)
    && Number.isFinite(afterMs)
    && receivedAtMs + MAIL_RECEIVED_AT_SKEW_MS >= afterMs;
}

export function createMailDashboardClient(
  mailDashboardBaseUrl: string,
  request: FetchLike = fetch,
): MailDashboardClient {
  const endpoint = baseUrl(mailDashboardBaseUrl);

  async function parse(response: Response): Promise<unknown> {
    if (!response.ok) throw new MailDashboardError();
    try {
      return await response.json();
    } catch {
      throw new MailDashboardError();
    }
  }

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    try {
      return await parse(await request(`${endpoint}${path}`, {
        ...init,
        headers: { Accept: "application/json", ...init?.headers },
        signal: AbortSignal.timeout(MAIL_DASHBOARD_REQUEST_TIMEOUT_MS),
      }));
    } catch (error) {
      if (error instanceof MailDashboardError) throw error;
      throw new MailDashboardError();
    }
  }

  return {
    async listMailboxes(): Promise<MailboxSourceRecord[]> {
      const payload = await call("/api/icloud/list");
      if (!isRecord(payload) || !Array.isArray(payload.emails)) throw new MailDashboardError();
      return payload.emails.flatMap((item) => {
        if (!isRecord(item)) return [];
        const email = text(item.email)?.toLowerCase();
        if (!email) return [];
        const appleLabel = text(item.appleLabel) ?? text(item.label);
        const group = text(item.group)?.toLowerCase() ?? "unknown";
        const registrationEligible = item.registrationEligible === true && group === "unused";
        return [{
          email,
          externalId: email,
          sourceRevision: `${email}:${appleLabel ?? ""}:${group}:${registrationEligible ? "eligible" : "blocked"}`,
          appleLabel,
          registrationEligible,
        }];
      });
    },

    async pollVerificationCode(email: string, after: string): Promise<VerificationCodeResult> {
      const payload = await call("/api/forward/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: [{ email, lastReceivedAt: after, force: false }] }),
      });
      if (!isRecord(payload) || !Array.isArray(payload.updates)) throw new MailDashboardError();
      const update = payload.updates.find((item) => isRecord(item) && text(item.email)?.toLowerCase() === email.toLowerCase());
      if (!isRecord(update)) return { status: "pending" };
      const code = text(update.code);
      const receivedAt = text(update.receivedAt);
      if (!code || !receivedAt || !isAfterOrEqual(receivedAt, after)) return { status: "pending" };
      return { status: "received", code, receivedAt };
    },
  };
}
