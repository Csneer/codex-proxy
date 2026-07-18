import { Hono } from "hono";
import { getAppearance, getBackgroundContentType, getBackgroundRevision, readBackground, removeBackground, replaceBackground, updateAppearance } from "../../ui-appearance/store.js";
export function createUiAppearanceRoutes(): Hono {
  const app = new Hono();
  const payload = () => ({ ...getAppearance(), backgroundUrl: `/admin/ui-background?v=${getBackgroundRevision()}` });
  app.get("/admin/ui-appearance", (c) => c.json(payload()));
  app.patch("/admin/ui-appearance", async (c) => { const body = await c.req.json() as Record<string, unknown>; const patch: Record<string, number | boolean | "light" | "dark"> = {}; for (const key of ["panelOpacity", "cardOpacity", "brightness", "blurPx", "enabled"]) if (typeof body[key] === "number" || typeof body[key] === "boolean") patch[key] = body[key] as never; if (body.theme === "light" || body.theme === "dark") patch.theme = body.theme; return c.json({ ...updateAppearance(patch), backgroundUrl: "/admin/ui-background" }); });
  app.post("/admin/ui-background", async (c) => { const body = Buffer.from(await c.req.arrayBuffer()); const type = c.req.header("content-type")?.split(";", 1)[0] ?? ""; try { replaceBackground(body, type); return c.json(payload()); } catch (error) { c.status(400); return c.json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.get("/admin/ui-background", (c) => { const bytes = readBackground(); if (!bytes) { c.status(404); return c.json({ error: "background_not_found" }); } c.header("Content-Type", getBackgroundContentType()); c.header("Cache-Control", "private, no-cache"); c.header("ETag", `W/\"${getBackgroundRevision()}\"`); return c.body(bytes as never); });
  app.delete("/admin/ui-background", (c) => { removeBackground(); return c.json({ ok: true }); });
  return app;
}
