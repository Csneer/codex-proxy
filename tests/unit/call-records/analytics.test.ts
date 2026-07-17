import { describe, expect, it } from "vitest";
import { resolveCallRange } from "@src/call-records/analytics.js";

describe("call analytics", () => {
  it("resolves Today using the supplied IANA timezone", () => {
    expect(resolveCallRange({ range: "today", timezone: "Asia/Shanghai", now: new Date("2026-07-18T04:00:00.000Z") })).toMatchObject({
      from: "2026-07-17T16:00:00.000Z",
      to: "2026-07-18T16:00:00.000Z",
      previousFrom: "2026-07-16T16:00:00.000Z",
      previousTo: "2026-07-17T16:00:00.000Z",
    });
  });

  it("rejects invalid timezones", () => {
    expect(() => resolveCallRange({ range: "24h", timezone: "not-a-zone" })).toThrow();
  });
});
