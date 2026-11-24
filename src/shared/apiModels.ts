import type { ApiModel, ApiProvider, Settings } from './settings'

/** Ready-made providers for "Add API". Any other OpenAI-compatible API works via "Custom". */
export const API_PRESETS: Array<{ id: string; name: string; baseUrl: string; keyUrl: string }> = [
  { id: 'venice', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', keyUrl: 'https://venice.ai/settings/api' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
]

/** Model ids LocalForge gives OpenCode for API models; the stats proxy routes on this prefix. */
export const API_MODEL_PREFIX = 'lf-api/'

export function apiRefOf(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** "<providerId>/<modelId>" → the configured provider + model (model ids may contain '/'). */
export function findApiModel(providers: ApiProvider[], ref: string): { provider: ApiProvider; model: ApiModel } | null {
  const i = ref.indexOf('/')
  if (i <= 0) return null
  const provider = providers.find((p) => p.id === ref.slice(0, i))
  const model = provider?.models.find((m) => m.id === ref.slice(i + 1))
  return provider && model ? { provider, model } : null
}

/** The API model chats use right now, or null for the local model. */
export function activeApiModel(s: Pick<Settings, 'api'>): { provider: ApiProvider; model: ApiModel } | null {
  return s.api.active ? findApiModel(s.api.providers, s.api.active) : null
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const int = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : def)

/** Keep only well-formed providers/models (settings.json is user-editable). */
export function sanitizeProviders(v: unknown): ApiProvider[] {
  if (!Array.isArray(v)) return []
  const out: ApiProvider[] = []
  for (const p of v as Array<Record<string, unknown>>) {
    if (!p || typeof p !== 'object') continue
    const id = str(p.id, 40)
    const baseUrl = str(p.baseUrl, 500).replace(/\/+$/, '')
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || out.some((o) => o.id === id)) continue
    try {
      const u = new URL(baseUrl)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
    } catch {
      continue
    }
    const models: ApiModel[] = []
    for (const m of Array.isArray(p.models) ? (p.models as Array<Record<string, unknown>>) : []) {
      if (!m || typeof m !== 'object') continue
      const mid = str(m.id, 200)
      if (!mid || /\s/.test(mid) || models.some((o) => o.id === mid)) continue
      models.push({
        id: mid,
        name: str(m.name, 120) || mid,
        contextLimit: int(m.contextLimit, 128_000),
        outputLimit: int(m.outputLimit, 16_384),
        vision: m.vision === true,
      })
    }
    out.push({ id, name: str(p.name, 60) || id, baseUrl, models })
  }
  return out
}
