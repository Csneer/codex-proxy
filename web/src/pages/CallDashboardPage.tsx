import { useState } from "preact/hooks";
import { useCallOverview, type OverviewRange } from "../../../shared/hooks/use-call-overview";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function CallDashboardPage() {
  const [range, setRange] = useState<OverviewRange>("today");
  const overview = useCallOverview(range);
  const data = overview.data;
  return <section class="flex flex-col gap-5">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div><p class="text-meta uppercase tracking-[.18em] text-slate-500">CALL ACTIVITY</p><h2 class="text-page-title font-semibold">调用大盘</h2><p class="text-reading text-slate-500">按时间范围查看成功调用、模型占比和当前活跃会话。</p></div>
      <div class="flex gap-1 rounded-xl glass-surface p-1">{(["today", "24h", "7d"] as OverviewRange[]).map((item) => <button key={item} class={`px-3 py-1.5 rounded-lg text-control ${range === item ? "bg-primary-action text-white" : "text-slate-600"}`} onClick={() => setRange(item)}>{item === "today" ? "今天" : item}</button>)}</div>
    </div>
    {overview.error && <div class="glass-surface rounded-xl p-4 text-reading text-red-600">无法读取调用总览：{overview.error}</div>}
    {overview.loading && !data && <div class="glass-surface rounded-xl p-6 text-reading text-slate-500">正在加载调用总览…</div>}
    {data && <>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[["成功调用", data.success.count.toLocaleString()], ["输入 tokens", data.usage.inputTokens.toLocaleString()], ["输出 tokens", data.usage.outputTokens.toLocaleString()], ["数据大小", bytes(data.storage.totalBytes)]].map(([label, value]) => <div key={label} class="glass-surface rounded-2xl p-4"><div class="text-control text-slate-500">{label}</div><div class="text-metric mt-2">{value}</div></div>)}
      </div>
      <div class="grid lg:grid-cols-2 gap-4">
        <div class="glass-surface rounded-2xl p-5"><h3 class="text-section font-semibold">模型使用占比</h3><div class="mt-4 flex flex-col gap-3">{data.models.length === 0 ? <p class="text-reading text-slate-500">当前范围暂无成功调用。</p> : data.models.map((model) => <div key={model.model}><div class="flex justify-between text-control"><span>{model.model}</span><span class="tabular-nums">{Math.round(model.share * 100)}% · {model.count}</span></div><div class="mt-1 h-2 rounded-full bg-primary-container overflow-hidden"><div class="h-full bg-primary rounded-full" style={{ width: `${model.share * 100}%` }} /></div></div>)}</div></div>
        <div class="glass-surface rounded-2xl p-5"><h3 class="text-section font-semibold">最新状态</h3><p class="mt-4 text-reading">{data.success.lastCompletedAt ? `最近成功调用：${new Date(data.success.lastCompletedAt).toLocaleString()}` : "当前范围暂无成功调用"}</p><p class="mt-2 text-control text-slate-500">缓存命中率：{Math.round(data.usage.cacheRatio * 100)}%</p><p class="mt-5 text-section font-semibold">活跃会话 / 任务</p><div class="mt-3 flex flex-col gap-2">{data.contexts.slice(0, 5).map((context) => <a key={context.id} href={`#/call-records?context=${encodeURIComponent(context.id)}`} class="rounded-xl bg-white/40 px-3 py-2 hover:bg-primary-container"><div class="text-reading font-medium truncate">{context.cwd ?? context.sessionId ?? context.taskId ?? "未命名会话"}</div><div class="text-meta text-slate-500">{context.callCount} 次调用 · {new Date(context.lastCompletedAt).toLocaleString()}</div></a>)}</div></div>
      </div>
    </>}
  </section>;
}
