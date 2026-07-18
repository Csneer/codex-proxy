import { useState } from "preact/hooks";
import { useCallOverview, type OverviewRange } from "../../../shared/hooks/use-call-overview";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function relativeTime(value: string | null): string {
  if (!value) return "暂无成功调用";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function trendPaths(series: Array<{ bucketStart: string; success: number }> | undefined) {
  const values = (series ?? []).map((item) => item.success);
  if (values.length === 0) return { area: "M35 160 L720 160 L35 160 Z", line: "M35 160" };
  const max = Math.max(...values, 1);
  const step = values.length === 1 ? 685 : 685 / (values.length - 1);
  const points = values.map((value, index) => `${Math.round(35 + step * index)} ${Math.round(160 - (value / max) * 125)}`);
  const line = `M${points.join(" L")}`;
  return { area: `${line} L720 160 L35 160 Z`, line };
}

export function CallDashboardPage() {
  const [range, setRange] = useState<OverviewRange>("today");
  const overview = useCallOverview(range);
  const data = overview.data;
  const trend = trendPaths(data?.series);
  const topModel = data?.models[0];
  const secondModel = data?.models[1];
  const topShare = topModel?.share ?? 0;
  const secondShare = secondModel?.share ?? 0;
  const otherShare = Math.max(0, 1 - topShare - secondShare);
  const modelGradient = `conic-gradient(rgb(var(--primary)) 0 ${topShare * 100}%, rgb(213 154 118) ${topShare * 100}% ${(topShare + secondShare) * 100}%, rgb(127 119 113) ${(topShare + secondShare) * 100}% 100%)`;

  return <section class="flex flex-col gap-5">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div><p class="text-meta uppercase tracking-[.18em] text-slate-500">CALL ACTIVITY</p><h2 class="text-page-title font-semibold">调用大盘</h2><p class="text-reading text-slate-500">先判断服务是否持续产生成功调用，再按会话和单次调用下钻。</p></div>
      <div class="flex gap-1 rounded-xl glass-surface p-1">{(["today", "24h", "7d"] as OverviewRange[]).map((item) => <button key={item} class={`px-3 py-1.5 rounded-lg text-control ${range === item ? "bg-primary-action text-white" : "text-slate-600 dark:text-text-dim"}`} onClick={() => setRange(item)}>{item === "today" ? "今天" : item}</button>)}</div>
    </div>
    {overview.error && <div class="glass-surface rounded-xl p-4 text-reading text-red-600">无法读取调用总览：{overview.error}</div>}
    {overview.loading && !data && <div class="glass-surface rounded-xl p-6 text-reading text-slate-500">正在加载调用总览…</div>}
    {data && <>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="glass-surface rounded-xl p-4"><div class="text-control text-slate-500">成功调用</div><div class="text-metric mt-2">{data.success.count.toLocaleString()}</div><div class="text-meta mt-2 text-success">↗ 较前一周期 {data.success.previousCount ? `${Math.round((data.success.count - data.success.previousCount) / data.success.previousCount * 100)}%` : "—"}</div></div>
        <div class="glass-surface rounded-xl p-4"><div class="text-control text-slate-500">最后成功</div><div class="text-metric mt-2">{relativeTime(data.success.lastCompletedAt)}</div><div class="text-meta mt-2 text-success">● 采集持续活跃</div></div>
        <div class="glass-surface rounded-xl p-4"><div class="text-control text-slate-500">Token 用量</div><div class="text-metric mt-2">{compact(data.usage.inputTokens + data.usage.outputTokens)}</div><div class="text-meta mt-2 text-slate-500">缓存命中 {Math.round(data.usage.cacheRatio * 100)}% · 输出 {compact(data.usage.outputTokens)}</div></div>
        <div class="glass-surface rounded-xl p-4"><div class="text-control text-slate-500">存储规模</div><div class="text-metric mt-2">{bytes(data.storage.totalBytes)}</div><div class="text-meta mt-2 text-warning">SQLite 持久化数据</div></div>
      </div>
      <div class="glass-surface rounded-xl px-4 py-3 flex flex-wrap gap-5 text-control"><strong>未成功计数</strong><span class="text-slate-500">仅聚合，不保存失败正文</span><span class="ml-auto">失败 <b>{data.outcomes?.failure ?? 0}</b></span><span>中断 <b>{data.outcomes?.interrupted ?? 0}</b></span><span>重试 <b>{data.outcomes?.retry ?? 0}</b></span></div>
      <div class="call-overview-analysis">
        <div class="glass-surface rounded-xl p-5"><div class="flex items-center gap-2"><h3 class="text-section font-semibold">今天的成功调用</h3><span class="text-meta text-slate-500">按小时 · {data.success.count.toLocaleString()} 次</span></div><div class="call-trend" aria-label="当前范围成功调用趋势"><svg viewBox="0 0 740 185" preserveAspectRatio="none"><line x1="35" y1="35" x2="720" y2="35" class="trend-grid"/><line x1="35" y1="100" x2="720" y2="100" class="trend-grid"/><line x1="35" y1="160" x2="720" y2="160" class="trend-grid"/><path class="trend-area" d={trend.area}/><path class="trend-line" d={trend.line}/></svg></div><div class="flex justify-between text-meta text-slate-500"><span>开始</span><span>当前范围</span><span>现在</span></div></div>
        <div class="flex flex-col gap-4">
          <div class="glass-surface rounded-xl p-5"><h3 class="text-section font-semibold">模型使用占比</h3><div class="model-donut-row"><div class="model-donut" style={{ background: modelGradient }}><span>{data.success.count.toLocaleString()}<small>调用</small></span></div><div class="model-legend">{data.models.slice(0, 2).map((model, index) => <div key={model.model}><i style={{ background: index === 0 ? "rgb(var(--primary))" : "rgb(213 154 118)" }} /><span>{model.model}</span><b>{Math.round(model.share * 100)}%</b></div>)}{otherShare > 0 && <div><i class="other" /><span>其它</span><b>{Math.round(otherShare * 100)}%</b></div>}</div></div></div>
          <div class="glass-surface rounded-xl p-5"><div class="flex items-center gap-2"><h3 class="text-section font-semibold">存储组成</h3><span class="text-meta text-slate-500">{bytes(data.storage.totalBytes)}</span></div><div class="storage-meter"><i style={{ width: "100%" }} /></div><div class="storage-list"><span>SQLite 数据库</span><b>{bytes(data.storage.totalBytes)}</b><span>原始证据与索引</span><b>按保留策略管理</b></div></div>
        </div>
      </div>
      <div class="glass-surface rounded-xl p-5"><div class="flex items-center justify-between gap-3"><h3 class="text-section font-semibold">活跃会话 / 任务</h3><span class="text-meta text-slate-500">按最后活动排序</span></div><div class="mt-3 flex flex-col gap-2">{data.contexts.slice(0, 5).map((context) => <a key={context.id} href={`#/call-records?context=${encodeURIComponent(context.id)}`} class="context-row"><div><div class="text-reading font-medium truncate">{context.cwd ?? context.sessionId ?? context.taskId ?? "未命名会话"}</div><div class="text-meta text-slate-500">{context.id}</div></div><div class="text-right text-meta text-slate-500"><b class="text-main">{context.callCount} 次调用</b><br />{new Date(context.lastCompletedAt).toLocaleString()}</div></a>)}</div></div>
    </>}
  </section>;
}
