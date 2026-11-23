import { useMemo } from 'react'
import { Cpu, Gauge, MemoryStick, Thermometer, Zap } from 'lucide-react'
import type { HardwareSample, TotalsStats } from '@shared/stats'
import { totalsKey, useStore } from '../../store'
import { Meter } from '../ui'
import { fmtInt, fmtMiB, fmtMs, fmtTps } from '../../format'

/** Small area chart of a series over the last few minutes. */
function Spark({ samples, value, max, color, label, unit, testId }: { samples: HardwareSample[]; value: (s: HardwareSample) => number; max: number; color: string; label: string; unit: string; testId: string }) {
  const W = 400
  const H = 64
  const now = samples.length ? samples[samples.length - 1].t : Date.now()
  const span = 5 * 60 * 1000
  const pts = samples.map((s) => [((s.t - (now - span)) / span) * W, H - (Math.min(max, Math.max(0, value(s))) / (max || 1)) * (H - 4) - 2] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = pts.length ? `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z` : ''
  const cur = samples.length ? value(samples[samples.length - 1]) : 0
  const peak = samples.reduce((m, s) => Math.max(m, value(s)), 0)
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">
          {unit === 'MiB' ? fmtMiB(cur) : `${cur.toFixed(1)} ${unit}`}
          <span className="ml-2 text-faint">peak {unit === 'MiB' ? fmtMiB(peak) : `${peak.toFixed(1)} ${unit}`}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-16 w-full rounded-md border border-line bg-code">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--lf-line)" strokeWidth={0.6} />
        ))}
        {area && <path d={area} fill={color} opacity={0.18} />}
        {line && <path d={line} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="mt-0.5 flex justify-between text-[10.5px] text-faint">
        <span>−5 min</span>
        <span>now</span>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-faint">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-0.5 text-[15px] tabular-nums">{value}</div>
    </div>
  )
}

function Totals({ title, t }: { title: string; t: TotalsStats | undefined }) {
  const avg = t && t.genMs > 0 ? (t.outputTokens / t.genMs) * 1000 : null
  return (
    <div className="rounded-lg border border-line bg-panel p-3" data-testid={`totals-${title.toLowerCase().split(' ')[0]}`}>
      <div className="mb-2 text-[12px] font-medium">{title}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
        <span className="text-faint">Total tokens</span>
        <span className="text-right tabular-nums">{fmtInt(t ? t.promptTokens + t.cachedTokens + t.outputTokens : 0)}</span>
        <span className="text-faint">· prompt processed</span>
        <span className="text-right tabular-nums">{fmtInt(t?.promptTokens ?? 0)}</span>
        <span className="text-faint">· cached</span>
        <span className="text-right tabular-nums">{fmtInt(t?.cachedTokens ?? 0)}</span>
        <span className="text-faint">· generated</span>
        <span className="text-right tabular-nums">{fmtInt(t?.outputTokens ?? 0)}</span>
        <span className="text-faint">· thinking</span>
        <span className="text-right tabular-nums">{fmtInt(t?.reasoningTokens ?? 0)}</span>
        <span className="text-faint">Generation time</span>
        <span className="text-right tabular-nums">{fmtMs(t?.genMs ?? 0)}</span>
        <span className="text-faint">Average speed</span>
        <span className="text-right tabular-nums">{fmtTps(avg)} t/s</span>
        <span className="text-faint">LLM calls</span>
        <span className="text-right tabular-nums">{fmtInt(t?.requests ?? 0)}</span>
        <span className="text-faint">Tool calls</span>
        <span className="text-right tabular-nums">{fmtInt(t?.toolCalls ?? 0)}</span>
      </div>
    </div>
  )
}

export function HardwarePanel() {
  const hw = useStore((s) => s.hardware)
  const settings = useStore((s) => s.settings)
  const llama = useStore((s) => s.llama)
  const projectId = useStore((s) => s.projectId)
  const sessionId = useStore((s) => s.sessionId)
  const sb = useStore((s) => (s.projectId ? s.sandbox[s.projectId] : undefined))
  const totals = useStore((s) => (s.projectId ? s.totals[totalsKey(s.projectId, s.sessionId)] : undefined))
  const projTotals = useStore((s) => (s.projectId ? s.totals[totalsKey(s.projectId, null)] : undefined))
  const last = hw[hw.length - 1]
  const g = last?.gpu
  const maxTps = useMemo(() => Math.max(10, ...hw.map((s) => s.tps)) * 1.15, [hw])
  if (!settings?.ui.stats.hardware) return <div className="p-4 text-[12.5px] text-muted">The Hardware panel is turned off in Settings → Stats.</div>
  return (
    <div className="h-full overflow-y-auto p-3" data-testid="hardware-panel">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[13px] font-medium">{g?.name ?? 'GPU'}</div>
        <div className="text-[11px] text-faint">nvidia-smi · 1 s</div>
      </div>
      {g ? (
        <>
          <div className="mb-3">
            <div className="mb-1 flex justify-between text-[12px]">
              <span className="text-muted">VRAM</span>
              <span className="tabular-nums" data-testid="vram-text">
                {fmtMiB(g.vramUsedMiB)} / {fmtMiB(g.vramTotalMiB)}
              </span>
            </div>
            <Meter value={g.vramUsedMiB} max={g.vramTotalMiB} tone={g.vramUsedMiB / g.vramTotalMiB > 0.95 ? 'warn' : 'info'} />
          </div>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <Stat icon={Gauge} label="GPU util" value={`${g.utilPct.toFixed(0)}%`} />
            <Stat icon={Thermometer} label="Temp" value={`${g.tempC.toFixed(0)} °C`} />
            <Stat icon={Zap} label="Power" value={`${g.powerW.toFixed(0)}${g.powerLimitW ? ` / ${g.powerLimitW.toFixed(0)}` : ''} W`} />
          </div>
        </>
      ) : (
        <div className="mb-3 text-[12.5px] text-muted">No NVIDIA GPU data (nvidia-smi not available).</div>
      )}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Stat icon={Cpu} label="Host CPU" value={`${(last?.cpuPct ?? 0).toFixed(0)}%`} />
        <Stat icon={MemoryStick} label="Host RAM" value={`${fmtMiB(last?.ramUsedMiB)} / ${fmtMiB(last?.ramTotalMiB)}`} />
      </div>
      {sb?.state === 'running' && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Stat icon={Cpu} label="Sandbox CPU" value={sb.cpuPct !== null ? `${sb.cpuPct.toFixed(0)}%` : '–'} />
          <Stat icon={MemoryStick} label="Sandbox RAM" value={`${fmtMiB(sb.memUsedMiB)} / ${fmtMiB(sb.memLimitMiB)}`} />
        </div>
      )}
      <div className="space-y-3">
        <Spark samples={hw} value={(s) => s.tps} max={maxTps} color="var(--lf-accent)" label="Generation speed" unit="t/s" testId="tps-graph" />
        <Spark samples={hw} value={(s) => s.gpu?.vramUsedMiB ?? 0} max={g?.vramTotalMiB ?? 16384} color="var(--lf-info)" label="VRAM" unit="MiB" testId="vram-graph" />
      </div>
      {llama?.up && (
        <div className="mt-3 rounded-lg border border-line bg-panel p-3 text-[12px]">
          <div className="mb-1 font-medium">llama-server</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <span className="text-faint">Model</span>
            <span className="truncate text-right" title={llama.modelAlias ?? ''}>
              {llama.modelAlias?.split('/').pop()}
            </span>
            <span className="text-faint">Context per slot</span>
            <span className="text-right tabular-nums">{fmtInt(llama.nCtx)}</span>
            <span className="text-faint">Slots busy</span>
            <span className="text-right tabular-nums">
              {llama.busySlots} / {llama.totalSlots}
            </span>
            <span className="text-faint">Vision</span>
            <span className="text-right">{llama.vision ? 'yes (mmproj)' : 'no'}</span>
            <span className="text-faint">Build</span>
            <span className="text-right">{llama.buildInfo}</span>
          </div>
        </div>
      )}
      {settings.ui.stats.totals && projectId && (
        <div className="mt-3 grid grid-cols-1 gap-2">
          {sessionId && <Totals title="Session totals" t={totals?.session} />}
          <Totals title="Project totals" t={projTotals?.project ?? totals?.project} />
        </div>
      )}
    </div>
  )
}
