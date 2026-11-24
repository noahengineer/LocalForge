import { useEffect, useMemo, useState } from 'react'
import { Check, Eye, KeyRound, Plus, Search, Trash2, X } from 'lucide-react'
import type { ApiModel, ApiProvider, Settings } from '@shared/settings'
import type { ApiModelInfo } from '@shared/api'
import { API_PRESETS, apiRefOf } from '@shared/apiModels'
import { api, errMsg } from '../api'
import { toast, updateSettings } from '../store'
import { Button, cx, Spinner } from './ui'

const input = 'rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] outline-none focus:border-line-strong'
const fmtK = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`)

const saveProviders = (providers: ApiProvider[]) => updateSettings({ api: { providers } })

/** Settings → API models: online models (any OpenAI-compatible API) next to the local one. */
export function ApiModelsSection({ s }: { s: Settings }) {
  const [keys, setKeys] = useState<{ keys: Record<string, boolean>; encrypted: boolean } | null>(null)
  const [custom, setCustom] = useState<{ name: string; baseUrl: string } | null>(null)
  const reloadKeys = () => void api.apiKeyStatus().then(setKeys).catch((e) => toast('error', errMsg(e)))
  useEffect(reloadKeys, [s.api.providers.length])

  const add = async (p: { id: string; name: string; baseUrl: string }) => {
    let id = p.id
    for (let n = 2; s.api.providers.some((x) => x.id === id); n++) id = `${p.id}-${n}`
    await saveProviders([...s.api.providers, { id, name: p.name, baseUrl: p.baseUrl.replace(/\/+$/, ''), models: [] }])
  }

  return (
    <div data-testid="api-models">
      <div className="mb-4 rounded-xl border border-line bg-bg p-3 text-[12.5px] text-muted">
        Use models from an online API (any OpenAI-compatible one) as well as your local model. Pick one in the chat&apos;s model menu, and switch back
        to local any time. <span className="text-fg">Your messages and project code are sent to that provider, and it charges per token.</span> The
        API key stays on this computer{keys ? (keys.encrypted ? ', encrypted with your system keyring' : ' (no system keyring found, so it is stored unencrypted, readable only by you)') : ''},
        and the agent&apos;s sandbox never sees it.
      </div>

      {s.api.providers.map((p) => (
        <ProviderCard key={p.id} s={s} p={p} hasKey={!!keys?.keys[p.id]} onKeyChanged={reloadKeys} />
      ))}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-muted">Add an API:</span>
        {API_PRESETS.map((pr) => (
          <Button key={pr.id} size="sm" variant="subtle" onClick={() => void add(pr)} data-testid={`api-add-${pr.id}`}>
            <Plus className="h-3.5 w-3.5" /> {pr.name}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setCustom({ name: '', baseUrl: 'https://' })}>
          Other…
        </Button>
      </div>
      {custom && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line p-3">
          <input className={cx(input, 'w-36')} placeholder="Name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
          <input
            className={cx(input, 'min-w-0 flex-1 font-mono')}
            placeholder="https://example.com/v1"
            value={custom.baseUrl}
            onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!custom.name.trim() || !/^https?:\/\/[^/]+/.test(custom.baseUrl)}
            onClick={() => {
              const id = custom.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'api'
              void add({ id, name: custom.name.trim(), baseUrl: custom.baseUrl.trim() }).then(() => setCustom(null))
            }}
          >
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCustom(null)}>
            Cancel
          </Button>
          <div className="w-full text-[11.5px] text-faint">The base URL is the part before /chat/completions.</div>
        </div>
      )}
    </div>
  )
}

function ProviderCard({ s, p, hasKey, onKeyChanged }: { s: Settings; p: ApiProvider; hasKey: boolean; onKeyChanged: () => void }) {
  const [key, setKey] = useState('')
  const [browse, setBrowse] = useState(false)
  const preset = API_PRESETS.find((x) => x.baseUrl === p.baseUrl)

  const update = (patch: Partial<ApiProvider>) => saveProviders(s.api.providers.map((x) => (x.id === p.id ? { ...x, ...patch } : x)))
  const saveKey = async (k: string) => {
    try {
      await api.setApiKey(p.id, k)
      setKey('')
      onKeyChanged()
      toast('success', k ? `${p.name} key saved` : `${p.name} key removed`)
    } catch (e) {
      toast('error', errMsg(e))
    }
  }
  const remove = async () => {
    if (!window.confirm(`Remove ${p.name} and its saved key?`)) return
    await api.setApiKey(p.id, '').catch(() => {})
    await saveProviders(s.api.providers.filter((x) => x.id !== p.id))
  }
  const removeModel = (id: string) => void update({ models: p.models.filter((m) => m.id !== id) })

  return (
    <div className="mb-3 rounded-xl border border-line p-3" data-testid={`api-provider-${p.id}`}>
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{p.name}</div>
          <div className="truncate font-mono text-[11.5px] text-faint">{p.baseUrl}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void remove()} title="Remove this API">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <KeyRound className={cx('h-3.5 w-3.5 shrink-0', hasKey ? 'text-ok' : 'text-faint')} />
        <input
          type="password"
          className={cx(input, 'min-w-0 flex-1 font-mono')}
          placeholder={hasKey ? 'Key saved. Paste a new one to replace it' : 'Paste your API key'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && void saveKey(key)}
          data-testid="api-key-input"
        />
        <Button size="sm" variant="primary" disabled={!key.trim()} onClick={() => void saveKey(key)}>
          Save key
        </Button>
        {hasKey && (
          <Button size="sm" variant="ghost" onClick={() => void saveKey('')}>
            Remove key
          </Button>
        )}
      </div>
      {!hasKey && preset && (
        <div className="mt-1 pl-5.5 text-[11.5px] text-faint">
          Get one at <span className="selectable font-mono">{preset.keyUrl}</span>
        </div>
      )}

      <div className="mt-3">
        {p.models.map((m) => {
          const ref = apiRefOf(p.id, m.id)
          const active = s.api.active === ref
          return (
            <div key={m.id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-[12.5px]">
              <span className="w-3.5 shrink-0">{active && <Check className="h-3.5 w-3.5 text-accent" />}</span>
              <span className="min-w-0 flex-1 truncate" title={m.id}>
                {m.name} <span className="font-mono text-[11px] text-faint">{m.id}</span>
              </span>
              {m.vision && <Eye className="h-3.5 w-3.5 shrink-0 text-faint" aria-label="Sees images" />}
              <span className="shrink-0 text-[11px] text-faint">{fmtK(m.contextLimit)} context</span>
              <Button size="sm" variant={active ? 'ghost' : 'subtle'} disabled={active} onClick={() => void updateSettings({ api: { active: ref } })}>
                {active ? 'In use' : 'Use'}
              </Button>
              <button className="rounded p-1 text-faint hover:text-fg" title="Remove model" onClick={() => removeModel(m.id)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
        {p.models.length === 0 && <div className="py-1 text-[12px] text-faint">No models added yet.</div>}
        {browse ? (
          <ModelBrowser p={p} onAdd={(m) => void update({ models: [...p.models.filter((x) => x.id !== m.id), m] })} onClose={() => setBrowse(false)} />
        ) : (
          <Button size="sm" variant="subtle" className="mt-1" onClick={() => setBrowse(true)} data-testid="api-browse">
            <Plus className="h-3.5 w-3.5" /> Add models
          </Button>
        )}
      </div>
    </div>
  )
}

function toApiModel(m: ApiModelInfo): ApiModel {
  return {
    id: m.id,
    name: m.name,
    contextLimit: m.contextLimit ?? 128_000,
    // OpenCode keeps this much room free for the answer; 32K is plenty for agent steps.
    outputLimit: Math.min(m.outputLimit ?? 32_768, 32_768),
    vision: m.vision,
  }
}

/** The provider's model list with search, plus adding a model by id. */
function ModelBrowser({ p, onAdd, onClose }: { p: ApiProvider; onAdd: (m: ApiModel) => void; onClose: () => void }) {
  const [list, setList] = useState<ApiModelInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [manual, setManual] = useState({ id: '', ctx: '128000' })
  useEffect(() => {
    void api
      .listApiModels(p.id)
      .then(setList)
      .catch((e) => setErr(errMsg(e)))
  }, [p.id])
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (list ?? []).filter((m) => !t || m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t))
  }, [list, q])
  const added = new Set(p.models.map((m) => m.id))

  return (
    <div className="mt-2 rounded-lg border border-line" data-testid="api-browser">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <Search className="h-3.5 w-3.5 text-faint" />
        <input autoFocus className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" placeholder={`Search ${p.name} models`} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="rounded p-1 text-faint hover:text-fg" onClick={onClose} title="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {!list && !err && (
          <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-faint">
            <Spinner className="h-3 w-3" /> Asking {p.name} for its models…
          </div>
        )}
        {err && <div className="px-2 py-2 text-[12px] text-bad">{err}</div>}
        {shown.map((m) => {
          const noTools = m.tools === false
          return (
            <div key={m.id} className={cx('flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px]', noTools && 'opacity-55')}>
              <span className="min-w-0 flex-1 truncate" title={m.id}>
                {m.name} <span className="font-mono text-[11px] text-faint">{m.id}</span>
              </span>
              {noTools && <span className="shrink-0 text-[11px] text-warn">can&apos;t use tools</span>}
              {m.vision && <Eye className="h-3.5 w-3.5 shrink-0 text-faint" />}
              {m.contextLimit && <span className="shrink-0 text-[11px] text-faint">{fmtK(m.contextLimit)}</span>}
              {added.has(m.id) ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
              ) : (
                <Button
                  size="sm"
                  variant="subtle"
                  title={noTools ? 'This model cannot call tools, so the agent cannot edit files or run commands with it' : undefined}
                  onClick={() => onAdd(toApiModel(m))}
                  data-testid={`api-add-model-${m.id}`}
                >
                  Add
                </Button>
              )}
            </div>
          )
        })}
        {list && shown.length === 0 && <div className="px-2 py-2 text-[12px] text-faint">No models match.</div>}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
        <input className={cx(input, 'min-w-0 flex-1 py-1 font-mono text-[12px]')} placeholder="Or type a model id" value={manual.id} onChange={(e) => setManual({ ...manual, id: e.target.value })} />
        <input
          type="number"
          className={cx(input, 'w-28 py-1 text-[12px]')}
          title="Context size (tokens)"
          value={manual.ctx}
          onChange={(e) => setManual({ ...manual, ctx: e.target.value })}
        />
        <Button
          size="sm"
          disabled={!manual.id.trim() || /\s/.test(manual.id.trim())}
          onClick={() => {
            onAdd(toApiModel({ id: manual.id.trim(), name: manual.id.trim(), contextLimit: Number(manual.ctx) || null, outputLimit: null, vision: false, tools: null }))
            setManual({ id: '', ctx: manual.ctx })
          }}
        >
          Add
        </Button>
      </div>
    </div>
  )
}
