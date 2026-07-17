import { Hono } from "hono";
import { getCallRecordStore } from "../../call-records/service.js";
import { CallRecordAnalytics } from "../../call-records/analytics.js";
export function createCallObservabilityRoutes(): Hono {
  const app = new Hono();
  app.get("/admin/call-observability/overview", (c) => {
    const store = getCallRecordStore();
    if (!store) { c.status(503); return c.json({ error: "call_record_store_unavailable" }); }
    const range = (c.req.query("range") || "today") as any;
    if (range && !["today", "24h", "7d"].includes(range)) { c.status(400); return c.json({ error: "invalid_range" }); }
    try { return c.json(new CallRecordAnalytics(store).getOverview({ range, timezone: c.req.query("timezone") })); }
    catch (e) { c.status(400); return c.json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  return app;
}
