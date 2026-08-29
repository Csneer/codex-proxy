import { describe, expect, it } from "vitest";
import { calculateLogMetrics } from "../../../src/logs/metrics.js";
import type { PricingCatalog } from "../../../src/auth/usage-pricing.js";

const catalog: PricingCatalog = {
  test: { input_usd_per_million: 1, cached_input_usd_per_million: 0.5, output_usd_per_million: 2 },
};

describe("calculateLogMetrics", () => {
  it("calculates duration, first-token latency, speed, and cost", () => {
    expect(calculateLogMetrics({ startMs: 1000, firstTokenMs: 1200, endMs: 2200, model: "test", usage: { input_tokens: 1000, cached_tokens: 200, output_tokens: 500 }, pricingCatalog: catalog, isStreaming: true })).toEqual({
      ttftMs: 200, durationMs: 1200, costUsd: 0.0019, tokensPerSecond: 500,
      inputTokens: 1000, outputTokens: 500, cachedTokens: 200, reasoningTokens: null, totalTokens: 1500,
    });
  });

  it("uses total duration as TTFT for completed non-streaming responses", () => {
    expect(calculateLogMetrics({ startMs: 0, endMs: 100, usage: { input_tokens: 1, output_tokens: 0 }, pricingCatalog: catalog, isStreaming: false }).ttftMs).toBe(100);
  });
});
