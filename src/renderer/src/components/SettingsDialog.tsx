import { useEffect, useState, type ReactNode } from 'react'
import type { Settings, StatsToggles } from '@shared/settings'
import type { HfModelInfo, ModelsInfo } from '@shared/api'
import { api, errMsg } from '../api'
import { toast, updateSettings, useStore } from '../store'
import { Button, cx, Dot, Modal, Spinner, Toggle } from './ui'

type Section = 'model' | 'sandbox' | 'stats' | 'general'

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="py-2">
      <label className="mb-1 block text-[13px]">{label}</label>
      {children}
      {hint && <div className="mt-1 text-[11.5px] text-muted">{hint}</div>}
    </div>
  )
}

const input = 'w-full rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] outline-none focus:border-line-strong'

function TextSetting({ value, onSave, mono, type = 'text' }: { value: string | number; onSave: (v: string) => void; mono?: boolean; type?: string }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  return <input type={type} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== String(value) && onSave(v)} className={cx(input, mono && 'font-mono')} />
}

const gb = (b: number | null | undefined) => (b === null || b === undefined ? '?' : `${(b / 1024 ** 3).toFixed(1)} GB`)

/** Pick which model llama-server runs: downloaded ones, or a new one from Hugging Face. */
function ModelPicker({ s }: { s: Settings }) {
  const llama = useStore((st) => st.llama)
  const [info, setInfo] = useState<ModelsInfo | null>(null)
  const [repo, setRepo] = useState('')
  const [hf, setHf] = useState<HfModelInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const [switching, setSwitching] = useState(false)
  const reload = () => void api.modelsInfo().then(setInfo).catch((e) => setErr(errMsg(e)))
  useEffect(reload, [])
  // While llama-server restarts (and possibly downloads), show its log.
  useEffect(() => {
    if (!switching) return
    const id = setInterval(() => {
      void api.llamaLogs().then((l) => setLog(l.split('\n').slice(-6).join('\n')))
    }, 2000)
    return () => clearInterval(id)
  }, [switching])
  useEffect(() => {
    if (switching && llama?.up) {
      setSwitching(false)
      reload()
    }
  }, [llama?.up, switching])

  const use = async (spec: string) => {
    if (!window.confirm(`Switch llama-server to\n${spec}?\n\nIt restarts now; a model that isn't downloaded yet is downloaded first. Running agents are interrupted.`)) return
    setBusy(spec)
    setErr(null)
    try {
      const r = await api.switchModel(spec)
      if (!r.ok) setErr(r.message)
      else {
        toast('info', r.message)
        setSwitching(true)
        setHf(null)
        reload()
      }
    } finally {
      setBusy(null)
    }
  }

  const lookup = async () => {
    setBusy('lookup')
    setErr(null)
    setHf(null)
    try {
      setHf(await api.lookupHfModel(repo))
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  const cur = info?.current
  return (
    <div className="mb-4 rounded-xl border border-line bg-bg p-3" data-testid="model-picker">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[13.5px] font-medium">Model</div>
        <div className="min-w-0 truncate font-mono text-[12px] text-muted">{cur ?? 'unknown'}</div>
        {switching && (
          <span className="ml-auto flex items-center gap-1.5 text-[12px] text-warn">
            <Spinner className="h-3 w-3" /> loading…
          </span>
        )}
      </div>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {info?.cached.map((m) => (
          <div key={m.path} className={cx('flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px]', m.spec === cur ? 'bg-accent-soft' : 'hover:bg-hover/60')}>
            <span className="min-w-0 flex-1 truncate font-mono" title={m.path}>
              {m.spec}
            </span>
            <span className="shrink-0 text-faint">{gb(m.sizeBytes)}</span>
            {m.vision && <span className="shrink-0 rounded bg-raised px-1 text-[10.5px] text-muted">vision</span>}
            {m.spec === cur ? (
              <span className="w-14 shrink-0 text-center text-[11.5px] text-accent">in use</span>
            ) : (
              <Button size="sm" variant="ghost" className="w-14 shrink-0" disabled={!!busy} onClick={() => void use(m.spec)}>
                {busy === m.spec ? <Spinner className="h-3 w-3" /> : 'Use'}
              </Button>
            )}
          </div>
        ))}
        {info && info.cached.length === 0 && <div className="text-[12px] text-faint">No downloaded GGUF models found.</div>}
      </div>
      <div className="mt-3 border-t border-line pt-3">
        <div className="mb-1 text-[12.5px]">Get a new model from Hugging Face</div>
        <div className="flex gap-2">
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && repo.trim() && void lookup()}
            placeholder="e.g. unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"
            className={cx(input, 'font-mono')}
            data-testid="hf-repo"
          />
          <Button size="sm" disabled={!repo.trim() || !!busy} onClick={() => void lookup()}>
            {busy === 'lookup' ? <Spinner className="h-3 w-3" /> : 'Look up'}
          </Button>
        </div>
        <div className="mt-1 text-[11.5px] text-faint">
          Downloads go to {info?.cacheDir ?? '~/.cache/huggingface/hub'} ({gb(info?.freeBytes)} free). For speed, pick a size that fits your GPU's 16 GB (the current model is ~16.5 GB and already spills onto the CPU).
        </div>
        {hf && (
          <div className="mt-2 space-y-1" data-testid="hf-quants">
            <div className="text-[12px] text-muted">
              {hf.repo} · {hf.vision ? 'can see images (mmproj)' : 'text only'}
              {hf.gated ? ' · gated: needs a Hugging Face login, may fail' : ''}
            </div>
            {hf.quants.map((q) => (
              <div key={q.quant} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px] hover:bg-hover/60">
                <span className="flex-1 font-mono">{q.quant}</span>
                <span className={cx('text-faint', info?.freeBytes !== null && info?.freeBytes !== undefined && q.sizeBytes > info.freeBytes && 'text-bad')}>{gb(q.sizeBytes)}</span>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void use(q.spec)}>
                  {busy === q.spec ? <Spinner className="h-3 w-3" /> : 'Download & use'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
      {info?.overridden && info.original && (
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-2 text-[12px] text-muted">
          <span className="min-w-0 flex-1 truncate">Your llama.service file still says {info.original}.</span>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void use(info.original!)}>
            Restore original
          </Button>
        </div>
      )}
      {info && (
        <div className="mt-3 border-t border-line pt-1" data-testid="single-slot">
          <Toggle
            checked={info.parallel === 1}
            label="One conversation at a time"
            hint={
              <>
                Every conversation, including each subagent, gets the full context, and others wait their turn. Without it, llama-server runs{' '}
                {info.parallel ?? 'automatic (4)'} conversations that share one {s.llama.contextLimit.toLocaleString('en-US')}-token memory, so two busy subagents can
                fail with "Context size has been exceeded". Changing this restarts llama-server.
              </>
            }
            onChange={(on) => {
              const busyNow = (llama?.busySlots ?? 0) > 0
              if (!window.confirm(`${on ? 'Turn on' : 'Turn off'} one conversation at a time?\n\nllama-server restarts now (about a minute).${busyNow ? '\n\nThe agent is working right now: its current step will be interrupted.' : ''}`)) return
              void api.setSingleSlot(on).then((r) => {
                toast(r.ok ? 'info' : 'error', r.message)
                if (r.ok) setSwitching(true)
                reload()
              })
            }}
          />
        </div>
      )}
      {err && <div className="mt-2 text-[12px] text-bad">{err}</div>}
      {switching && log && <pre className="selectable mt-2 max-h-28 overflow-auto rounded-lg border border-line bg-code p-2 font-mono text-[10.5px] text-muted">{log}</pre>}
    </div>
  )
}

function ModelSection({ s }: { s: Settings }) {
  const llama = useStore((st) => st.llama)
  const [busy, setBusy] = useState<string | null>(null)
  const [logs, setLogs] = useState<string | null>(null)
  const control = async (a: 'start' | 'stop' | 'restart') => {
    setBusy(a)
    try {
      const r = await api.llamaControl(a)
      toast(r.ok ? 'success' : 'error', r.ok ? `systemctl --user ${a} ${s.llama.systemdUnit}: ok` : r.message)
    } catch (e) {
      toast('error', errMsg(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div>
      <div className="mb-3 flex items-center gap-3 rounded-xl border border-line bg-bg p-3">
        <Dot color={llama?.up ? 'ok' : 'bad'} />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px]">{llama?.up ? 'llama-server is running' : 'llama-server is not reachable'}</div>
          <div className="truncate text-[12px] text-muted">
            {llama?.up ? `${llama.modelAlias} · ctx ${llama.nCtx} · ${llama.totalSlots} slots · vision ${llama.vision ? 'on' : 'off'}` : (llama?.error ?? '')} · unit {llama?.unitState ?? 'unknown'}
          </div>
        </div>
        <Button size="sm" disabled={!!busy} onClick={() => void control('start')}>
          {busy === 'start' ? <Spinner className="h-3 w-3" /> : 'Start'}
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => void control('restart')}>
          {busy === 'restart' ? <Spinner className="h-3 w-3" /> : 'Restart'}
        </Button>
        <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void control('stop')}>
          {busy === 'stop' ? <Spinner className="h-3 w-3" /> : 'Stop'}
        </Button>
      </div>
      <ModelPicker s={s} />
      <Field label="llama-server endpoint" hint="Base URL of llama-server on this machine. Sandboxes reach it only through the LocalForge stats proxy.">
        <TextSetting mono value={s.llama.baseUrl} onSave={(v) => void updateSettings({ llama: { baseUrl: v } })} />
      </Field>
      <Field label="systemd user unit" hint="Controlled with systemctl --user (start / restart / stop).">
        <TextSetting mono value={s.llama.systemdUnit} onSave={(v) => void updateSettings({ llama: { systemdUnit: v } })} />
      </Field>
      <Field label="Model display name" hint="Leave empty to use the name reported by llama-server.">
        <TextSetting value={s.llama.modelName} onSave={(v) => void updateSettings({ llama: { modelName: v } })} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Context limit (tokens)" hint="Sent to OpenCode as limit.context.">
          <TextSetting type="number" value={s.llama.contextLimit} onSave={(v) => void updateSettings({ llama: { contextLimit: Number(v) } })} />
        </Field>
        <Field label="Output limit (tokens)" hint="Sent to OpenCode as limit.output.">
          <TextSetting type="number" value={s.llama.outputLimit} onSave={(v) => void updateSettings({ llama: { outputLimit: Number(v) } })} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Stats proxy port" hint="127.0.0.1 only. Changing it needs a sandbox reset.">
          <TextSetting type="number" value={s.proxy.port} onSave={(v) => void updateSettings({ proxy: { port: Number(v) } })} />
        </Field>
        <div className="pt-6">
          <Toggle checked={s.proxy.injectStats} onChange={(v) => void updateSettings({ proxy: { injectStats: v } })} label="Live stats from llama-server" hint="Adds timings_per_token and return_progress to streamed requests." />
        </div>
      </div>
      <div className="mt-2">
        <Button size="sm" variant="ghost" onClick={() => void api.llamaLogs().then(setLogs)}>
          Show llama-server log
        </Button>
        {logs !== null && <pre className="selectable mt-2 max-h-72 overflow-auto rounded-lg border border-line bg-code p-2.5 font-mono text-[11px] text-muted">{logs}</pre>}
      </div>
    </div>
  )
}

function SandboxSection({ s }: { s: Settings }) {
  const image = useStore((st) => st.image)
  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="CPU limit (cores)" hint="Applied live to existing sandboxes.">
          <TextSetting type="number" value={s.sandbox.cpus} onSave={(v) => void updateSettings({ sandbox: { cpus: Number(v) } })} />
        </Field>
        <Field label="Memory limit (GB)">
          <TextSetting type="number" value={s.sandbox.memoryGb} onSave={(v) => void updateSettings({ sandbox: { memoryGb: Number(v) } })} />
        </Field>
      </div>
      <Toggle
        checked={s.agent.requireApproval}
        onChange={(v) => void updateSettings({ agent: { requireApproval: v } })}
        label="Require approval for tool calls"
        hint="Off (default): everything runs automatically, because it runs inside the isolated sandbox. On: edits, shell commands, web access and desktop control ask first."
      />
      <Toggle checked={s.agent.autoCheckpoint} onChange={(v) => void updateSettings({ agent: { autoCheckpoint: v } })} label="Checkpoint after every agent turn" hint="A git commit inside the sandbox after each completed turn, used by Undo to checkpoint." />
      <Toggle checked={s.sandbox.stopOnQuit} onChange={(v) => void updateSettings({ sandbox: { stopOnQuit: v } })} label="Stop sandboxes when LocalForge quits" />
      <Field label="Desktop click coordinates" hint="How the computer-use tools interpret x/y from the model.">
        <select value={s.sandbox.computerUseCoords} onChange={(e) => void updateSettings({ sandbox: { computerUseCoords: e.target.value as 'pixels' | 'norm1000' } })} className={input}>
          <option value="pixels">Screenshot pixels</option>
          <option value="norm1000">Relative 0–1000 (Qwen-VL grounding style)</option>
        </select>
      </Field>
      <Field label="Podman storage root" hint="Where LocalForge's images and containers are stored. Empty = podman's default (~/.local/share/containers). Changing it hides existing sandboxes.">
        <TextSetting mono value={s.sandbox.podmanRoot} onSave={(v) => void updateSettings({ sandbox: { podmanRoot: v } })} />
      </Field>
      <Field label="Projects folder">
        <TextSetting mono value={s.projects.root} onSave={(v) => void updateSettings({ projects: { root: v } })} />
      </Field>
      <div className="mt-2 rounded-lg border border-line bg-bg p-3 text-[12px] text-muted">
        Sandbox image: <span className="font-mono text-fg">{image?.tag ?? 'unknown'}</span> · {image?.status}
        {image?.status !== 'building' && (
          <Button size="sm" variant="ghost" className="ml-2" onClick={() => void api.buildImage().catch((e) => toast('error', errMsg(e)))}>
            Build now
          </Button>
        )}
      </div>
    </div>
  )
}

const STAT_LABELS: Array<[keyof StatsToggles, string, string]> = [
  ['thinking', 'Thinking blocks', 'Live reasoning, collapsed with duration and token count afterwards.'],
  ['liveStatus', 'Live status line', 'Phase, tokens/s, tokens generated and elapsed time while generating.'],
  ['promptProgress', 'Prompt-processing progress', 'Progress bar with % and ETA while the prompt is processed.'],
  ['messageFooter', 'Message stats footer', 'Prompt/cached/thinking/output tokens, speeds, TTFT and total time.'],
  ['contextMeter', 'Context meter', 'Used / max context in the top bar (amber at 75%, red at 90%).'],
  ['totals', 'Session and project totals', 'Shown in the Hardware panel.'],
  ['hardware', 'Hardware panel', 'GPU, CPU and RAM with rolling graphs.'],
]

function StatsSection({ s }: { s: Settings }) {
  return (
    <div>
      <Field label="Stats detail">
        <div className="flex overflow-hidden rounded-lg border border-line text-[13px]">
          {(['compact', 'detailed'] as const).map((m) => (
            <button key={m} onClick={() => void updateSettings({ ui: { statsMode: m } })} className={cx('flex-1 px-3 py-1.5 capitalize', s.ui.statsMode === m ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover')}>
              {m}
            </button>
          ))}
        </div>
      </Field>
      {STAT_LABELS.map(([k, label, hint]) => (
        <Toggle key={k} checked={s.ui.stats[k]} onChange={(v) => void updateSettings({ ui: { stats: { [k]: v } } })} label={label} hint={hint} />
      ))}
    </div>
  )
}

function GeneralSection({ s }: { s: Settings }) {
  return (
    <div>
      <Field label="Theme">
        <div className="flex overflow-hidden rounded-lg border border-line text-[13px]">
          {(['dark', 'light', 'system'] as const).map((m) => (
            <button key={m} onClick={() => void updateSettings({ ui: { theme: m } })} className={cx('flex-1 px-3 py-1.5 capitalize', s.ui.theme === m ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover')}>
              {m}
            </button>
          ))}
        </div>
      </Field>
      <div className="mt-4 text-[12px] text-muted">Settings are stored in ~/.config/LocalForge/settings.json.</div>
    </div>
  )
}

export function SettingsDialog() {
  const s = useStore((st) => st.settings)
  const [sec, setSec] = useState<Section>('model')
  if (!s) return null
  const nav: Array<[Section, string]> = [
    ['model', 'Model'],
    ['sandbox', 'Sandbox & agent'],
    ['stats', 'Stats'],
    ['general', 'Appearance'],
  ]
  return (
    <Modal title="Settings" onClose={() => useStore.setState({ showSettings: false })} width="max-w-4xl">
      <div className="flex min-h-[480px]">
        <nav className="w-48 shrink-0 border-r border-line p-2">
          {nav.map(([id, label]) => (
            <button key={id} onClick={() => setSec(id)} className={cx('block w-full rounded-lg px-3 py-1.5 text-left text-[13px]', sec === id ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}>
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 p-5">
          {sec === 'model' && <ModelSection s={s} />}
          {sec === 'sandbox' && <SandboxSection s={s} />}
          {sec === 'stats' && <StatsSection s={s} />}
          {sec === 'general' && <GeneralSection s={s} />}
        </div>
      </div>
    </Modal>
  )
}
