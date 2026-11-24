import type { ApiModelInfo } from '../../shared/api'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null)

/**
 * A provider's GET /models answer → models. Understands the plain OpenAI shape ({data:[{id}]}),
 * Venice's model_spec (context, capabilities) and OpenRouter's fields (context_length,
 * architecture, supported_parameters). Embedding/image/audio models are left out where marked.
 */
export function parseApiModels(json: unknown): ApiModelInfo[] {
  const j = obj(json)
  const list = Array.isArray(j.data) ? j.data : Array.isArray(json) ? (json as unknown[]) : []
  const out: ApiModelInfo[] = []
  for (const raw of list) {
    const m = obj(raw)
    const id = typeof m.id === 'string' ? m.id : null
    if (!id || out.some((o) => o.id === id)) continue
    if (typeof m.type === 'string' && m.type !== 'text' && m.type !== 'chat') continue
    const spec = obj(m.model_spec)
    const caps = obj(spec.capabilities)
    const arch = obj(m.architecture)
    const top = obj(m.top_provider)
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as unknown[]) : null
    const inputs = Array.isArray(arch.input_modalities) ? (arch.input_modalities as unknown[]) : []
    let tools: boolean | null = null
    if (typeof caps.supportsFunctionCalling === 'boolean') tools = caps.supportsFunctionCalling
    else if (params) tools = params.includes('tools')
    out.push({
      id,
      name: (typeof spec.name === 'string' && spec.name) || (typeof m.name === 'string' && m.name) || id,
      contextLimit: num(spec.availableContextTokens) ?? num(m.context_length) ?? num(top.context_length) ?? num(m.context_window),
      outputLimit: num(spec.maxCompletionTokens) ?? num(top.max_completion_tokens) ?? num(m.max_output_tokens),
      vision: caps.supportsVision === true || inputs.includes('image'),
      tools,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
