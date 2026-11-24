import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cloud, Cpu } from 'lucide-react'
import type { ModelsInfo } from '@shared/api'
import { api, errMsg } from '../../api'
import { toast, updateSettings, useStore } from '../../store'
import { activeApiModel, apiRefOf } from '@shared/apiModels'
import { prettyModel } from '../../format'
import { cx, Spinner } from '../ui'
import { Popover } from '../Popover'

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`

/** Model pill + quick switcher in the composer (the full picker stays in Settings → Model). */
export function ModelControl() {
  const llama = useStore((s) => s.llama)
  const modelName = useStore((s) => s.settings?.llama.modelName ?? '')
  const apiSettings = useStore((s) => s.settings?.api)
  const activeApi = apiSettings ? activeApiModel({ api: apiSettings }) : null
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
  const localLabel = loading ? 'loading model…' : modelName || (llama?.modelAlias ? prettyModel(llama.modelAlias).split(' · ')[0] : 'no model')
  const label = activeApi ? activeApi.model.name : localLabel

  const useApi = (ref: string) => {
    void updateSettings({ api: { active: ref } }).then(() => setOpen(false))
  }

  const use = async (spec: string) => {
    // Already loaded: just go back from the API model to the local one, no restart.
    if (spec === info?.current) {
      await updateSettings({ api: { active: '' } })
      setOpen(false)
      return
    }
    const busyNow = (llama?.busySlots ?? 0) > 0
    const msg = `Switch to ${prettyModel(spec)}?\n\nllama-server restarts and loads it (about a minute).${busyNow ? '\n\nThe agent is working right now: its current step will be interrupted.' : ''}`
    if (!window.confirm(msg)) return
    setBusy(spec)
    try {
      const r = await api.switchModel(spec)
      toast(r.ok ? 'info' : 'error', r.message)
      if (r.ok) {
        if (activeApi) await updateSettings({ api: { active: '' } })
        setOpen(false)
      }
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
        title={activeApi ? `${activeApi.provider.name}: ${activeApi.model.id}` : (llama?.modelAlias ?? 'Model')}
        className={cx(
          'inline-flex h-7 w-full max-w-[200px] items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[12.5px] transition-colors',
          open ? 'border-line-strong text-fg' : 'border-line text-muted hover:text-fg',
        )}
      >
        {activeApi ? <Cloud className="h-3.5 w-3.5 shrink-0" /> : loading ? <Spinner className="h-3 w-3" /> : <Cpu className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      {open && (
        <Popover anchor={btn} width={340} onClose={() => setOpen(false)} testId="model-popover">
          <div className="p-1.5">
          <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-muted">On this computer</div>
          {!info && (
            <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-faint">
              <Spinner className="h-3 w-3" /> Looking for downloaded models…
            </div>
          )}
          {info?.cached.map((m) => {
            const loaded = m.spec === info.current
            const current = loaded && !activeApi
            return (
              <button
                key={m.path}
                disabled={current || !!busy}
                data-testid="model-local"
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
          {apiSettings?.providers.some((p) => p.models.length > 0) && (
            <div className="mt-1 border-t border-line pt-1" data-testid="model-api-list">
              <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-muted">Online (API, paid per use)</div>
              {apiSettings.providers.flatMap((p) =>
                p.models.map((m) => {
                  const ref = apiRefOf(p.id, m.id)
                  const current = apiSettings.active === ref
                  return (
                    <button
                      key={ref}
                      disabled={current || !!busy}
                      onClick={() => useApi(ref)}
                      className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px]', current ? 'cursor-default' : 'hover:bg-hover')}
                      title={`${p.name}: ${m.id}`}
                      data-testid="model-api"
                    >
                      <span className="w-3.5 shrink-0">{current ? <Check className="h-3.5 w-3.5 text-accent" /> : null}</span>
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="shrink-0 text-[11px] text-faint">{p.name}</span>
                    </button>
                  )
                }),
              )}
            </div>
          )}
          <div className="mt-1 border-t border-line pt-1">
            <button
              className="w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                setOpen(false)
                useStore.setState({ showSettings: true, settingsSection: 'model' })
              }}
            >
              Download other models…
            </button>
            <button
              className="w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                setOpen(false)
                useStore.setState({ showSettings: true, settingsSection: 'api' })
              }}
              data-testid="model-add-api"
            >
              Add API models…
            </button>
          </div>
          </div>
        </Popover>
      )}
    </div>
  )
}
