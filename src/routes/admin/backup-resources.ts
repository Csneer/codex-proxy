import { Hono, type Context } from "hono";
import { z } from "zod";
import { getBackupResourceStore } from "../../backup-resources/service.js";
import {
  AccountFactoryPromotionError,
  AccountFactoryRevisionConflict,
  type BackupResourceStore,
} from "../../backup-resources/store.js";
import type { AccountFactoryPromotionService } from "../../backup-resources/promotion.js";
import { BACKUP_ACCOUNT_STATUSES } from "../../backup-resources/types.js";

const NullableText = z.string().max(10_000).nullable();
const NullableLargeSecret = z.string().max(1024 * 1024).nullable();
const AccountStatusSchema = z.enum(BACKUP_ACCOUNT_STATUSES);
const AccountCreateSchema = z.object({
  email: z.string().trim().min(1).max(320),
  accountStatus: AccountStatusSchema.optional(),
  emailPassword: NullableText.optional(),
  chatgptPassword: NullableText.optional(),
  totpSecret: NullableText.optional(),
  emailCodeUrl: NullableText.optional(),
  session: NullableLargeSecret.optional(),
  accessToken: NullableLargeSecret.optional(),
  refreshToken: NullableLargeSecret.optional(),
  note: NullableText.optional(),
}).strict();
const AccountPatchSchema = AccountCreateSchema.partial().refine((value) => Object.keys(value).length > 0);
const PhoneCreateSchema = z.object({
  phoneNumber: z.string().trim().min(1).max(128),
  useCount: z.number().int().min(0).optional(),
  note: NullableText.optional(),
}).strict();
const PhonePatchSchema = PhoneCreateSchema.partial().refine((value) => Object.keys(value).length > 0);
const PromoteSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(512),
  expectedRevision: z.number().int().nonnegative(),
  allowEphemeral: z.boolean().optional().default(false),
}).strict();

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function invalid(c: Context): Response {
  c.status(400);
  return c.json({ error: "invalid_request" });
}

function notFound(c: Context): Response {
  c.status(404);
  return c.json({ error: "not_found" });
}

export function createBackupResourceRoutes(
  resolveStore: () => BackupResourceStore = getBackupResourceStore,
  resolvePromotionService?: () => Pick<AccountFactoryPromotionService, "promote">,
): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AccountFactoryRevisionConflict) {
      c.status(409);
      return c.json({ error: "revision_conflict", ...error.syncState });
    }
    if (error instanceof AccountFactoryPromotionError) {
      c.status(error.code === "not_found" ? 404 : error.code === "invalid_payload" ? 400 : 409);
      return c.json({ error: error.code === "invalid_payload" ? "invalid_request" : error.code });
    }
    const errorCode = error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : undefined;
    console.error("[BackupResources] request failed", {
      method: c.req.method,
      path: c.req.path,
      errorType: error instanceof Error ? error.name : "UnknownError",
      ...(errorCode ? { errorCode } : {}),
    });
    c.status(500);
    return c.json({ error: "backup_resources_unavailable" });
  });

  app.get("/admin/backup-resources/accounts", (c) => {
    const store = resolveStore();
    return c.json(store.listAccounts().map((account) => ({
      ...account,
      promotion: store.getPromotion(account.id),
    })));
  });
  app.post("/admin/backup-resources/accounts", async (c) => {
    const body = await parseBody(c, AccountCreateSchema);
    if (!body) return invalid(c);
    c.status(201);
    return c.json(resolveStore().createAccount(body));
  });
  app.get("/admin/backup-resources/accounts/:id", (c) => {
    const account = resolveStore().getAccount(c.req.param("id"));
    if (!account) return notFound(c);
    c.header("Cache-Control", "no-store");
    return c.json(account);
  });
  app.patch("/admin/backup-resources/accounts/:id", async (c) => {
    const body = await parseBody(c, AccountPatchSchema);
    if (!body) return invalid(c);
    const account = resolveStore().updateAccount(c.req.param("id"), body);
    return account ? c.json(account) : notFound(c);
  });
  app.delete("/admin/backup-resources/accounts/:id", (c) => {
    if (!resolveStore().deleteAccount(c.req.param("id"))) return notFound(c);
    return c.json({ ok: true });
  });
  app.post("/admin/backup-resources/accounts/:id/promote", async (c) => {
    const body = await parseBody(c, PromoteSchema);
    if (!body) return invalid(c);
    if (!resolvePromotionService) {
      c.status(409);
      return c.json({ error: "promotion_unavailable" });
    }
    c.header("Cache-Control", "no-store");
    const promotion = await resolvePromotionService().promote(c.req.param("id"), {
      ...body,
      allowEphemeral: body.allowEphemeral ?? false,
    });
    return c.json({ promotion });
  });

  app.get("/admin/backup-resources/phones", (c) => c.json(resolveStore().listPhones()));
  app.post("/admin/backup-resources/phones", async (c) => {
    const body = await parseBody(c, PhoneCreateSchema);
    if (!body) return invalid(c);
    c.status(201);
    return c.json(resolveStore().createPhone(body));
  });
  app.get("/admin/backup-resources/phones/:id", (c) => {
    const phone = resolveStore().getPhone(c.req.param("id"));
    return phone ? c.json(phone) : notFound(c);
  });
  app.patch("/admin/backup-resources/phones/:id", async (c) => {
    const body = await parseBody(c, PhonePatchSchema);
    if (!body) return invalid(c);
    const phone = resolveStore().updatePhone(c.req.param("id"), body);
    return phone ? c.json(phone) : notFound(c);
  });
  app.delete("/admin/backup-resources/phones/:id", (c) => {
    if (!resolveStore().deletePhone(c.req.param("id"))) return notFound(c);
    return c.json({ ok: true });
  });
  app.post("/admin/backup-resources/phones/:id/use", (c) => {
    const phone = resolveStore().usePhone(c.req.param("id"));
    return phone ? c.json(phone) : notFound(c);
  });

  return app;
}
