import { useState } from 'react'
import { Box, Cpu, Layers, PanelLeft, PanelRight, Play, RotateCw, Square } from 'lucide-react'
import { api, errMsg } from '../api'
import { selectProject, toast, useStore } from '../store'
import { cx, Dot, IconButton, Spinner } from './ui'
import { fmtInt, fmtMiB, prettyModel } from '../format'

/** Context used / max for the current session, with OpenCode's auto-compaction threshold. */
export function ContextMeter() {
  const sessionId = useStore((s) => s.sessionId)
  const settings = useStore((s) => s.settings)
  const llama = useStore((s) => s.llama)
  const last = useStore((s) => (s.sessionId ? s.lastBySession[s.sessionId] : undefined))
  const live = useStore((s) => Object.values(s.live).find((r) => r.sessionId === s.sessionId && r.kind === 'agent'))
  const compactedAt = useStore((s) => (s.sessionId ? s.compactions[s.sessionId] : undefined))
  if (!settings?.ui.stats.contextMeter || !sessionId) return null
  const max = settings.llama.contextLimit || llama?.nCtx || 65536
  let used = 0
  if (live && live.promptTotal) used = live.promptTotal + live.predictedN
  else if (last?.usage?.total_tokens) used = last.usage.total_tokens
  else if (last) used = (last.promptTotal ?? 0) + last.predictedN
  const pct = (used / max) * 100
  const tone = pct >= 90 ? 'bg-bad' : pct >= 75 ? 'bg-warn' : 'bg-accent'
  // OpenCode compacts at context - min(output limit, 32000).
  const compactAt = ((max - Math.min(settings.llama.outputLimit, 32000)) / max) * 100
  return (
    <div className="flex items-center gap-2" title={`Context: ${fmtInt(used)} of ${fmtInt(max)} tokens (${pct.toFixed(1)}%). OpenCode compacts the conversation at ${compactAt.toFixed(0)}%.`} data-testid="context-meter">
      <span className="text-[11.5px] text-faint">Context</span>
      <div className="relative h-1.5 w-28 overflow-hidden rounded-full bg-line">
        <div className={cx('h-full rounded-full transition-[width] duration-500', tone)} style={{ width: `${Math.min(100, pct)}%` }} />
        <div className="absolute top-0 h-full w-px bg-fg/40" style={{ left: `${compactAt}%` }} />
      </div>
      <span className={cx('tabular-nums text-[12px]', pct >= 90 ? 'text-bad' : pct >= 75 ? 'text-warn' : 'text-muted')} data-testid="context-text">
        {fmtInt(used)} / {fmtInt(max)}
      </span>
      {compactedAt && (
        <span className="inline-flex items-center gap-1 rounded bg-raised px-1.5 text-[11px] text-muted" title={`Compacted at ${new Date(compactedAt).toLocaleTimeString()}`} data-testid="compacted-badge">
          <Layers className="h-3 w-3" /> compacted
        </span>
      )}
    </div>
  )
}

/** "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M" -> "Qwen3.8-27B · UD-Q4_K_M" */

function ModelStatus() {
  const llama = useStore((s) => s.llama)
  const settings = useStore((s) => s.settings)
  const [busy, setBusy] = useState(false)
  const up = llama?.up
  const name = settings?.llama.modelName || (llama?.modelAlias ? prettyModel(llama.modelAlias) : 'llama-server')
  const control = async (a: 'start' | 'restart') => {
    setBusy(true)
    try {
      const r = await api.llamaControl(a)
      toast(r.ok ? 'success' : 'error', r.ok ? `llama-server ${a}ed` : r.message)
    } catch (e) {
      toast('error', errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1" data-testid="model-status" data-up={up ? 'true' : 'false'} title={llama?.error ?? `${llama?.modelAlias ?? ''}\nslots busy: ${llama?.busySlots ?? 0}/${llama?.totalSlots ?? '?'}`}>
      <Dot color={up ? (llama?.busySlots ? 'info' : 'ok') : llama?.unitState === 'active' ? 'warn' : 'bad'} pulse={!!llama?.busySlots || (!up && llama?.unitState === 'active')} />
      <button className="max-w-[220px] truncate text-[12.5px] hover:underline" title="Change model (Settings)" onClick={() => useStore.setState({ showSettings: true })}>
        {up ? name : llama?.unitState === 'active' || llama?.unitState === 'activating' ? 'loading model…' : name}
      </button>
      {!up && llama?.unitState !== 'active' && (
        <button className="text-[12px] text-accent hover:underline" disabled={busy} onClick={() => void control(llama?.unitState === 'active' ? 'restart' : 'start')}>
          {busy ? <Spinner className="h-3 w-3" /> : llama?.unitState === 'active' ? 'Restart' : 'Start'}
        </button>
      )}
    </div>
  )
}

function SandboxStatusPill({ projectId }: { projectId: string }) {
  const sb = useStore((s) => s.sandbox[projectId])
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (what: 'stop' | 'start' | 'reset') => {
    if (what === 'reset' && !window.confirm('Reset sandbox?\n\nThe container is deleted and rebuilt from the current image. Your project files and chat sessions are kept; anything installed inside the container (apt packages, caches) is lost.')) return
    setBusy(what)
    try {
      if (what === 'stop') await api.stopSandbox(projectId)
      else if (what === 'start') await selectProject(projectId, useStore.getState().sessionId)
      else {
        await api.resetSandbox(projectId)
        await selectProject(projectId, useStore.getState().sessionId)
        toast('success', 'Sandbox rebuilt')
      }
    } catch (e) {
      toast('error', errMsg(e))
    } finally {
      setBusy(null)
    }
  }
  const state = sb?.state ?? 'missing'
  const running = state === 'running'
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1" data-testid="sandbox-status" data-state={state}>
      <Box className="h-3.5 w-3.5 text-muted" />
      <Dot color={running ? 'ok' : state === 'error' ? 'bad' : state === 'stopped' || state === 'missing' ? 'muted' : 'warn'} pulse={state === 'starting' || state === 'creating'} />
      <span className="text-[12.5px] capitalize">{running ? 'Sandbox' : state}</span>
      {running && sb?.cpuPct !== null && sb?.cpuPct !== undefined && (
        <span className="inline-flex items-center gap-1 text-[11.5px] tabular-nums text-muted">
          <Cpu className="h-3 w-3" />
          {sb.cpuPct.toFixed(0)}% · {fmtMiB(sb.memUsedMiB)} / {fmtMiB(sb.memLimitMiB)}
        </span>
      )}
      <div className="ml-1 flex items-center">
        {running ? (
          <IconButton title="Stop sandbox" onClick={() => void run('stop')} className="h-6 w-6">
            {busy === 'stop' ? <Spinner className="h-3 w-3" /> : <Square className="h-3 w-3" />}
          </IconButton>
        ) : (
          <IconButton title="Start sandbox" onClick={() => void run('start')} className="h-6 w-6">
            {busy === 'start' ? <Spinner className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </IconButton>
        )}
        <IconButton title="Reset sandbox (rebuild container, keep files)" onClick={() => void run('reset')} className="h-6 w-6" data-testid="reset-sandbox">
          {busy === 'reset' ? <Spinner className="h-3 w-3" /> : <RotateCw className="h-3 w-3" />}
        </IconButton>
      </div>
    </div>
  )
}

export function TopBar() {
  const projectId = useStore((s) => s.projectId)
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectId))
  const session = useStore((s) => (s.projectId && s.sessionId ? s.sessions[s.projectId]?.find((x) => x.id === s.sessionId) : undefined))
  const rightOpen = useStore((s) => s.rightOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4" data-testid="topbar">
      {!sidebarOpen && (
        <IconButton title="Show projects" onClick={() => useStore.setState({ sidebarOpen: true })} data-testid="sidebar-open">
          <PanelLeft className="h-4 w-4" />
        </IconButton>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium">{session?.title ?? project?.name ?? 'LocalForge'}</div>
        {project && <div className="truncate text-[11px] text-faint">{project.path}</div>}
      </div>
      <ContextMeter />
      <ModelStatus />
      {projectId && <SandboxStatusPill projectId={projectId} />}
      <IconButton active={rightOpen} title="Toggle side panel" onClick={() => useStore.setState({ rightOpen: !rightOpen })}>
        <PanelRight className="h-4 w-4" />
      </IconButton>
    </header>
  )
}
