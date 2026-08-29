import { calculateUsageCostUsd, loadPricingCatalog, type PricingCatalog, type UsageCostInput } from "../auth/usage-pricing.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";
export interface LogMetrics { ttftMs?: number | null; durationMs?: number | null; costUsd?: number | null; tokensPerSecond?: number | null; inputTokens?: number | null; outputTokens?: number | null; cachedTokens?: number | null; reasoningTokens?: number | null; totalTokens?: number | null; }
export interface CalculateLogMetricsOptions { startMs: number; firstTokenMs?: number | null; endMs?: number; model?: string | null; usage?: UsageInfo | UsageCostInput | null; pricingCatalog?: PricingCatalog; isStreaming?: boolean; }
let cachedCatalog: PricingCatalog | null = null;
function getCatalog(): PricingCatalog { if (!cachedCatalog) { try { cachedCatalog = loadPricingCatalog(); } catch { cachedCatalog = {}; } } return cachedCatalog; }
export function resetPricingCatalogCache(): void { cachedCatalog = null; }
export function calculateLogMetrics(options: CalculateLogMetricsOptions): LogMetrics {
  const { startMs, firstTokenMs, endMs = Date.now(), model, usage, pricingCatalog = getCatalog(), isStreaming = firstTokenMs !== undefined } = options;
  const durationMs = Math.max(0, Math.round(endMs - startMs));
  let ttftMs: number | null = null;
  if (firstTokenMs != null && Number.isFinite(firstTokenMs)) ttftMs = Math.max(0, Math.round(firstTokenMs - startMs));
  else if (!isStreaming && durationMs > 0 && firstTokenMs === undefined) ttftMs = durationMs;
  let costUsd: number | null = null, tokensPerSecond: number | null = null;
  let inputTokens: number | null = null, outputTokens: number | null = null, cachedTokens: number | null = null, reasoningTokens: number | null = null, totalTokens: number | null = null;
  if (usage) {
    inputTokens = usage.input_tokens ?? 0; outputTokens = usage.output_tokens ?? 0; cachedTokens = usage.cached_tokens ?? 0;
    if ("reasoning_tokens" in usage) reasoningTokens = usage.reasoning_tokens ?? 0;
    totalTokens = inputTokens + outputTokens;
    if (model) costUsd = Math.round(calculateUsageCostUsd(model, usage, pricingCatalog) * 1_000_000) / 1_000_000;
    if (outputTokens > 0) {
      if (firstTokenMs != null && endMs - firstTokenMs >= 20) tokensPerSecond = Math.round(outputTokens / ((endMs - firstTokenMs) / 1000) * 10) / 10;
      else if (durationMs > 0) tokensPerSecond = Math.round(outputTokens / (durationMs / 1000) * 10) / 10;
    } else tokensPerSecond = 0;
  }
  return { ttftMs, durationMs, costUsd, tokensPerSecond, inputTokens, outputTokens, cachedTokens, reasoningTokens, totalTokens };
}
