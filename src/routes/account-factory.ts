import { Hono, type Context } from "hono";
import { z } from "zod";
import { getConfig } from "../config.js";
import { getBackupResourceStore } from "../backup-resources/service.js";
import {
  AccountFactoryPromotionError,
  AccountFactoryRevisionConflict,
  type BackupResourceStore,
} from "../backup-resources/store.js";
import type { AccountFactoryPromotionService } from "../backup-resources/promotion.js";
import { BACKUP_ACCOUNT_STATUSES } from "../backup-resources/types.js";
import {
  createMailDashboardClient,
  MailDashboardError,
  type MailDashboardClient,
} from "../services/mail-dashboard-client.js";

const BASE_PATH = "/integration/account-factory/v1";
const Text = z.string().trim().min(1).max(512);
const Secret = z.string().max(1024 * 1024);
const Operation = z.object({
  leaseId: Text,
  taskId: Text,
  operationId: Text.optional(),
  idempotencyKey: Text.optional(),
}).strict();
const SubmissionCommit = Operation.extend({
  schemaVersion: z.literal(1),
  idempotencyKey: Text,
}).strict();
const Claim = z.object({
  consumerId: Text,
  taskId: Text,
  leaseTtlMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
  operationId: Text.optional(),
}).strict();
const Progress = Operation.extend({
  progress: z.unknown().refine((value) => value !== undefined),
}).strict().refine((value) => Boolean(value.operationId || value.idempotencyKey), {
  message: "operation identity is required",
});
const Complete = Operation.extend({
  schemaVersion: z.literal(1),
  operationId: Text,
  idempotencyKey: Text,
  sourceRevision: z.number().int().nonnegative(),
  password: Secret.optional(),
  chatgptPassword: Secret.optional(),
  emailPassword: Secret.nullable().optional(),
  totpSecret: Secret.nullable().optional(),
  session: z.union([Secret, z.record(z.unknown())]).nullable().optional(),
  accessToken: Secret.nullable().optional(),
  refreshToken: Secret.nullable().optional(),
  accountStatus: z.enum(BACKUP_ACCOUNT_STATUSES).optional(),
  registrationRoute: Text.nullable().optional(),
  eligibilityStatus: Text.nullable().optional(),
  eligibilityReason: Secret.nullable().optional(),
  eligibilityCheckedAt: z.string().datetime({ offset: true }).nullable().optional(),
  validityStatus: Text.nullable().optional(),
}).strict().refine((value) => Boolean(value.password || value.chatgptPassword), {
  message: "password is required",
});
const Fail = Operation.extend({ errorCode: Text }).strict().refine((value) => Boolean(value.operationId || value.idempotencyKey), {
  message: "operation identity is required",
});
const VerificationQuery = z.object({
  after: z.string().datetime({ offset: true }),
  taskId: Text,
  leaseId: Text,
}).strict();
const SyncQuery = z.object({ taskId: Text, leaseId: Text }).strict();
const Promote = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: Text,
  expectedRevision: z.number().int().nonnegative(),
  allowEphemeral: z.boolean().optional().default(false),
}).strict();

export interface AccountFactoryRouteDependencies {
  resolveStore?: () => BackupResourceStore;
  resolveMailClient?: () => MailDashboardClient;
  resolvePromotionService?: () => Pick<AccountFactoryPromotionService, "promote">;
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function responseError(c: Context, status: 400 | 404 | 409 | 502, error: string): Response {
  c.status(status);
  return c.json({ error });
}

function leaseForAccount(c: Context, store: BackupResourceStore, taskId: string, leaseId?: string) {
  const lease = store.getLease(taskId);
  return lease && lease.accountId === c.req.param("id") && (leaseId === undefined || lease.id === leaseId) ? lease : null;
}

function leaseResponse(lease: ReturnType<BackupResourceStore["getLease"]> & {}): Omit<NonNullable<ReturnType<BackupResourceStore["getLease"]>>, "progress"> & { hasProgress: boolean } {
  const { progress, ...safeLease } = lease;
  return { ...safeLease, hasProgress: progress !== null };
}

export function createAccountFactoryRoutes(dependencies: AccountFactoryRouteDependencies = {}): Hono {
  const store = dependencies.resolveStore ?? getBackupResourceStore;
  const mail = dependencies.resolveMailClient ?? (() => createMailDashboardClient(getConfig().account_factory.mail_dashboard_base_url));
  const app = new Hono();

  app.onError((error, c) => {
    console.error("[AccountFactory] request failed", {
      method: c.req.method,
      path: c.req.path,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    if (error instanceof MailDashboardError) return responseError(c, 502, "mail_service_unavailable");
    if (error instanceof AccountFactoryRevisionConflict) {
      c.status(409);
      return c.json({ error: "revision_conflict", ...error.syncState });
    }
    if (error instanceof AccountFactoryPromotionError) {
      if (error.code === "invalid_payload") return responseError(c, 400, "invalid_request");
      if (error.code === "not_found") return responseError(c, 404, "not_found");
      return responseError(c, 409, error.code);
    }
    if (error instanceof Error && error.message.includes("not found")) return responseError(c, 404, "not_found");
    if (error instanceof Error && error.message.includes("Invalid")) return responseError(c, 400, "invalid_request");
    return responseError(c, 409, "lease_conflict");
  });

  app.get(`${BASE_PATH}/health`, (c) => c.json({
    enabled: true,
    schemaVersion: 1,
    capabilities: ["claim", "submissionCommit", "poll", "progress", "syncState", "complete", "fail", "promote"],
  }));

  app.post(`${BASE_PATH}/mailboxes/sync`, async (c) => {
    const mailboxes = await mail().listMailboxes();
    const accounts = mailboxes.map((mailbox) => store().syncSourceAccount({
      sourceSystem: "mail_dashboard",
      externalId: mailbox.externalId,
      email: mailbox.email,
      sourceRevision: mailbox.sourceRevision,
      appleLabel: mailbox.appleLabel,
      active: true,
    }));
    const reconciliation = store().reconcileSourceAccounts({
      sourceSystem: "mail_dashboard",
      activeExternalIds: mailboxes.map((mailbox) => mailbox.externalId),
    });
    return c.json({ accounts, reconciliation });
  });

  app.post(`${BASE_PATH}/claims`, async (c) => {
    const input = await body(c, Claim);
    if (!input) return responseError(c, 400, "invalid_request");
    const result = store().claimAccount(input);
    if (!result) return responseError(c, 409, "no_inventory");
    c.status(result.replayed ? 200 : 201);
    return c.json({
      account: result.account,
      lease: leaseResponse(result.lease),
      replayed: result.replayed,
    });
  });

  app.post(`${BASE_PATH}/accounts/:id/submission-commit`, async (c) => {
    const input = await body(c, SubmissionCommit);
    if (!input) return responseError(c, 400, "invalid_request");
    if (!leaseForAccount(c, store(), input.taskId, input.leaseId)) return responseError(c, 404, "not_found");
    return c.json({ lease: leaseResponse(store().commitSubmission(input)) });
  });

  app.get(`${BASE_PATH}/accounts/:id/verification-code`, async (c) => {
    const query = VerificationQuery.safeParse(c.req.query());
    if (!query.success) return responseError(c, 400, "invalid_request");
    const lease = leaseForAccount(c, store(), query.data.taskId);
    if (!lease || lease.id !== query.data.leaseId) return responseError(c, 404, "not_found");
    const account = store().getAccount(c.req.param("id"));
    if (!account) return responseError(c, 404, "not_found");
    const result = await mail().pollVerificationCode(account.email, query.data.after);
    if (result.status === "pending") return c.json({ status: "pending" });
    return c.json(result);
  });

  app.patch(`${BASE_PATH}/accounts/:id/progress`, async (c) => {
    const input = await body(c, Progress);
    if (!input) return responseError(c, 400, "invalid_request");
    if (!leaseForAccount(c, store(), input.taskId, input.leaseId)) return responseError(c, 404, "not_found");
    return c.json({ lease: leaseResponse(store().reportProgress({
      leaseId: input.leaseId,
      taskId: input.taskId,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      progress: input.progress,
    })) });
  });

  app.get(`${BASE_PATH}/accounts/:id/sync-state`, (c) => {
    const query = SyncQuery.safeParse(c.req.query());
    if (!query.success) return responseError(c, 400, "invalid_request");
    const lease = leaseForAccount(c, store(), query.data.taskId);
    if (!lease || lease.id !== query.data.leaseId) return responseError(c, 404, "not_found");
    c.header("Cache-Control", "no-store");
    const syncState = store().getAccountSyncState(c.req.param("id"));
    if (!syncState) return responseError(c, 404, "not_found");
    return c.json(syncState);
  });

  app.post(`${BASE_PATH}/accounts/:id/complete`, async (c) => {
    const input = await body(c, Complete);
    if (!input) return responseError(c, 400, "invalid_request");
    if (!leaseForAccount(c, store(), input.taskId, input.leaseId)) return responseError(c, 404, "not_found");
    c.header("Cache-Control", "no-store");
    return c.json(store().completeLease(input));
  });

  app.post(`${BASE_PATH}/accounts/:id/promote`, async (c) => {
    const input = await body(c, Promote);
    if (!input) return responseError(c, 400, "invalid_request");
    if (!dependencies.resolvePromotionService) return responseError(c, 409, "promotion_unavailable");
    c.header("Cache-Control", "no-store");
    const promotion = await dependencies.resolvePromotionService().promote(c.req.param("id"), {
      ...input,
      allowEphemeral: input.allowEphemeral ?? false,
    });
    return c.json({ promotion });
  });

  app.post(`${BASE_PATH}/accounts/:id/fail`, async (c) => {
    const input = await body(c, Fail);
    if (!input) return responseError(c, 400, "invalid_request");
    if (!leaseForAccount(c, store(), input.taskId, input.leaseId)) return responseError(c, 404, "not_found");
    return c.json({ lease: leaseResponse(store().failLease(input)) });
  });

  return app;
}
