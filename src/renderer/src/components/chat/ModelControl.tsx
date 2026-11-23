import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu } from 'lucide-react'
import type { ModelsInfo } from '@shared/api'
import { api, errMsg } from '../../api'
import { toast, useStore } from '../../store'
import { prettyModel } from '../../format'
import { cx, Spinner } from '../ui'
import { Popover } from '../Popover'

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`

/** Model pill + quick switcher in the composer (the full picker stays in Settings → Model). */
export function ModelControl() {
  const llama = useStore((s) => s.llama)
  const modelName = useStore((s) => s.settings?.llama.modelName ?? '')
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<ModelsInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    void api
      .modelsInfo()
      .then(setInfo)
      .catch((e) => toast('error', errMsg(e)))
  }, [open])

  const loading = !llama?.up && (llama?.unitState === 'active' || llama?.unitState === 'activating')
  const label = loading ? 'loading model…' : modelName || (llama?.modelAlias ? prettyModel(llama.modelAlias).split(' · ')[0] : 'no model')

  const use = async (spec: string) => {
    const busyNow = (llama?.busySlots ?? 0) > 0
    const msg = `Switch to ${prettyModel(spec)}?\n\nllama-server restarts and loads it (about a minute).${busyNow ? '\n\nThe agent is working right now: its current step will be interrupted.' : ''}`
    if (!window.confirm(msg)) return
    setBusy(spec)
    try {
      const r = await api.switchModel(spec)
      toast(r.ok ? 'info' : 'error', r.message)
      if (r.ok) setOpen(false)
    } catch (e) {
      toast('error', errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative min-w-[76px] shrink">
      <button
        ref={btn}
        onClick={() => setOpen((o) => !o)}
        data-testid="model-pill"
        title={llama?.modelAlias ?? 'Model'}
        className={cx(
          'inline-flex h-7 w-full max-w-[200px] items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[12.5px] transition-colors',
          open ? 'border-line-strong text-fg' : 'border-line text-muted hover:text-fg',
        )}
      >
        {loading ? <Spinner className="h-3 w-3" /> : <Cpu className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      {open && (
        <Popover anchor={btn} width={340} onClose={() => setOpen(false)} testId="model-popover">
          <div className="p-1.5">
          <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-muted">Model</div>
          {!info && (
            <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-faint">
              <Spinner className="h-3 w-3" /> Looking for downloaded models…
            </div>
          )}
          {info?.cached.map((m) => {
            const current = m.spec === info.current
            return (
              <button
                key={m.path}
                disabled={current || !!busy}
                onClick={() => void use(m.spec)}
                className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px]', current ? 'cursor-default' : 'hover:bg-hover')}
                title={m.spec}
              >
                <span className="w-3.5 shrink-0">{current ? <Check className="h-3.5 w-3.5 text-accent" /> : busy === m.spec ? <Spinner className="h-3 w-3" /> : null}</span>
                <span className="min-w-0 flex-1 truncate">{prettyModel(m.spec)}</span>
                <span className="shrink-0 text-[11px] text-faint">{gb(m.sizeBytes)}</span>
              </button>
            )
          })}
          {info && info.cached.length === 0 && <div className="px-2 py-2 text-[12px] text-faint">No downloaded models found.</div>}
          <div className="mt-1 border-t border-line pt-1">
            <button
              className="w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                setOpen(false)
                useStore.setState({ showSettings: true })
              }}
            >
              Download other models…
            </button>
          </div>
          </div>
        </Popover>
      )}
    </div>
  )
}
