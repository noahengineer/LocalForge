import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LlamaServerStatus } from '../../shared/stats'

const execFileP = promisify(execFile)

async function getJson<T>(url: string, timeoutMs = 2500): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return (await r.json()) as T
  } finally {
    clearTimeout(t)
  }
}

interface PropsResponse {
  default_generation_settings?: { n_ctx?: number }
  total_slots?: number
  model_alias?: string
  model_path?: string
  modalities?: { vision?: boolean }
  build_info?: string
  chat_template?: string
  chat_template_caps?: { supports_reasoning_effort?: boolean; reasoning_effort_levels?: string[] }
}

interface SlotInfo {
  id: number
  n_ctx: number
  is_processing: boolean
  n_prompt_tokens?: number
  n_prompt_tokens_processed?: number
  n_prompt_tokens_cache?: number
  next_token?: Array<{ n_decoded?: number; n_remain?: number }>
}

export async function fetchSlots(baseUrl: string): Promise<SlotInfo[]> {
  return getJson<SlotInfo[]>(`${baseUrl.replace(/\/$/, '')}/slots`)
}

/** Parse Prometheus text exposition into a flat name -> value map (no labels support needed). */
export function parseMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line)
    if (!m) continue
    const v = Number(m[3])
    if (Number.isFinite(v)) out[m[1]] = v
  }
  return out
}

export async function fetchMetrics(baseUrl: string): Promise<Record<string, number>> {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/metrics`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return parseMetrics(await r.text())
}

export async function systemdUnitState(unit: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '--value'], { timeout: 4000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function getLlamaStatus(baseUrl: string, unit: string): Promise<LlamaServerStatus> {
  const base = baseUrl.replace(/\/$/, '')
  const unitState = await systemdUnitState(unit)
  try {
    const health = await getJson<{ status?: string }>(`${base}/health`)
    if (health.status !== 'ok') throw new Error(`health: ${health.status ?? 'unknown'}`)
    const props = await getJson<PropsResponse>(`${base}/props`)
    let busy = 0
    try {
      busy = (await fetchSlots(base)).filter((s) => s.is_processing).length
    } catch {
      /* /slots may be disabled */
    }
    return {
      up: true,
      unitState,
      modelAlias: props.model_alias ?? props.model_path ?? null,
      nCtx: props.default_generation_settings?.n_ctx ?? null,
      totalSlots: props.total_slots ?? null,
      vision: props.modalities?.vision === true,
      busySlots: busy,
      buildInfo: props.build_info ?? null,
      reasoningLevels: props.chat_template_caps?.supports_reasoning_effort && props.chat_template_caps.reasoning_effort_levels?.length ? props.chat_template_caps.reasoning_effort_levels : null,
      reasoningDefault: /reasoning_effort\s*\|\s*default\(\s*['"]([\w-]+)['"]/.exec(props.chat_template ?? '')?.[1] ?? null,
      error: null,
    }
  } catch (e) {
    return {
      up: false,
      unitState,
      modelAlias: null,
      nCtx: null,
      totalSlots: null,
      vision: false,
      busySlots: 0,
      buildInfo: null,
      reasoningLevels: null,
      reasoningDefault: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function controlUnit(unit: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout, stderr } = await execFileP('systemctl', ['--user', action, unit], { timeout: 30000 })
    return { ok: true, message: (stdout + stderr).trim() }
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    return { ok: false, message: (err.stderr || err.message).trim() }
  }
}

/** Last lines of the unit's journal, for the settings/troubleshooting view. */
export async function unitLogs(unit: string, lines = 80): Promise<string> {
  try {
    const { stdout } = await execFileP('journalctl', ['--user', '-u', unit, '-n', String(lines), '--no-pager', '-o', 'cat'], {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
