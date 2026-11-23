import { useRef } from 'react'
import type { LlmRequestStats } from '@shared/stats'
import type { StatsToggles } from '@shared/settings'
import { cx, Meter, useTick } from '../ui'
import { fmtInt, fmtMs, fmtTps } from '../../format'

const PHASE: Record<string, string> = {
  queued: 'Waiting for model',
  prompt: 'Processing prompt',
  thinking: 'Thinking',
  writing: 'Writing',
  tool: 'Calling tool',
}

/** Smoothly extrapolated prompt progress between llama-server's per-batch progress chunks. */
export function interpolatePrompt(r: LlmRequestStats & { receivedAt: number }, now: number): { pct: number; etaMs: number | null; done: number; todo: number } {
  const todo = Math.max(0, (r.promptTotal ?? 0) - (r.promptCached ?? 0))
  const done = Math.max(0, (r.promptProcessed ?? 0) - (r.promptCached ?? 0))
  const base = r.promptProgress ?? 0
  if (r.promptEtaMs === null || r.promptEtaMs <= 0 || base >= 1) return { pct: base * 100, etaMs: r.promptEtaMs, done, todo }
  const since = Math.max(0, now - r.receivedAt)
  const frac = Math.min(0.98, since / r.promptEtaMs)
  const p = base + (1 - base) * frac
  return { pct: p * 100, etaMs: Math.max(0, r.promptEtaMs - since), done: Math.round(todo * p), todo }
}

/** The live line under the conversation while a response is generating. */
export function LiveStatus({ req, toggles, busySince, runningTool }: { req: (LlmRequestStats & { receivedAt: number }) | null; toggles: StatsToggles; busySince: number | null; runningTool: string | null }) {
  const now = useTick(200)
  // The interpolation can run slightly ahead of llama-server's next real update (prompt processing
  // slows down as the context grows), so never let the bar move backwards within one request.
  const shown = useRef<{ id: string; pct: number }>({ id: '', pct: 0 })
  if (!toggles.liveStatus) return null
  if (!req) {
    // The agent is busy but not talking to the model right now (e.g. running a tool).
    return (
      <div className="flex items-center gap-3 px-1 py-1.5 text-[12.5px] text-muted" data-testid="live-status" data-phase="tool-running">
        <span className="lf-shimmer-text font-medium">{runningTool ? `Running ${runningTool}` : 'Working'}</span>
        {busySince && <span className="text-faint">{fmtMs(now - busySince)}</span>}
      </div>
    )
  }
  const phase = req.phase
  const elapsed = now - req.startedAt
  const showPrompt = toggles.promptProgress && (phase === 'prompt' || phase === 'queued') && (req.promptTotal ?? 0) > 0
  let pp = showPrompt ? interpolatePrompt(req, now) : null
  if (pp) {
    if (shown.current.id !== req.id) shown.current = { id: req.id, pct: 0 }
    const pct = Math.max(shown.current.pct, pp.pct)
    shown.current.pct = pct
    pp = { ...pp, pct, done: Math.max(pp.done, Math.round((pp.todo * pct) / 100)) }
  }
  const genElapsed = req.firstTokenAt ? now - req.firstTokenAt : 0
  return (
    <div className="space-y-1.5 px-1 py-1.5" data-testid="live-status" data-phase={phase}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        <span className={cx('font-medium', phase === 'thinking' ? 'text-plan' : 'text-accent', 'lf-pulse')}>●</span>
        <span className="lf-shimmer-text font-medium" data-testid="live-phase">
          {PHASE[phase] ?? phase}
        </span>
        {pp && (
          <span className="text-muted" data-testid="prompt-progress-text">
            {Math.floor(pp.pct)}% · {fmtInt(pp.done)} / {fmtInt(pp.todo)} tokens
            {(req.promptCached ?? 0) > 0 && <span className="text-faint"> (+{fmtInt(req.promptCached)} cached)</span>}
            {pp.etaMs !== null && <span> · ~{fmtMs(pp.etaMs)} left</span>}
          </span>
        )}
        {!showPrompt && req.predictedN > 0 && (
          <>
            <span className="tabular-nums text-fg" data-testid="live-tps">
              {fmtTps(req.predictedPerSecond)} t/s
            </span>
            <span className="tabular-nums text-muted" data-testid="live-tokens">
              {fmtInt(req.predictedN)} tokens
              {req.reasoningTokens > 0 && <span className="text-faint"> ({fmtInt(req.reasoningTokens)} thinking)</span>}
            </span>
            <span className="text-faint">gen {fmtMs(genElapsed)}</span>
          </>
        )}
        <span className="ml-auto tabular-nums text-faint">{fmtMs(elapsed)}</span>
      </div>
      {pp && <Meter value={pp.pct} max={100} tone="accent" className="h-1" />}
    </div>
  )
}
