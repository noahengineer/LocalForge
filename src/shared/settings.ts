/** App settings (persisted to ~/.config/LocalForge/settings.json). */

export interface StatsToggles {
  thinking: boolean // live Thinking block
  liveStatus: boolean // phase / progress / tokens/s line while generating
  promptProgress: boolean // prompt-processing progress bar + ETA
  messageFooter: boolean // per-message stats footer
  contextMeter: boolean // context meter in the top bar
  totals: boolean // session/project totals
  hardware: boolean // Hardware panel
}

/** A model served by an OpenAI-compatible API (Venice, OpenRouter, OpenAI…). */
export interface ApiModel {
  /** The provider's model id, sent as `model`. */
  id: string
  name: string
  contextLimit: number
  outputLimit: number
  vision: boolean
}

/**
 * An OpenAI-compatible API. Its key is NOT here: it lives in api-keys.json (encrypted with the OS
 * keyring when available) and is only added by the stats proxy, so it never enters a sandbox.
 */
export interface ApiProvider {
  id: string
  name: string
  /** e.g. https://api.venice.ai/api/v1 (the part before /chat/completions). */
  baseUrl: string
  models: ApiModel[]
}

export interface Settings {
  api: {
    /** The model chats use: '' = the local llama-server model, else "<providerId>/<modelId>". */
    active: string
    providers: ApiProvider[]
  }
  llama: {
    /** llama-server base URL as seen from the host. */
    baseUrl: string
    /** systemd --user unit that runs llama-server. */
    systemdUnit: string
    /** Display name for the model (auto-detected when empty). */
    modelName: string
    contextLimit: number
    outputLimit: number
    /**
     * How hard the model thinks: one of the loaded model's levels (e.g. low/medium/xhigh), 'none' for
     * no thinking, or '' for the model's default. Sent per request by the stats proxy, and only when
     * the loaded model accepts the value.
     */
    reasoningEffort: string
    /** Run llama-server with -np 1 so each conversation gets the full context (see models.ts). */
    singleSlot: boolean
  }
  proxy: {
    port: number
    /** Add timings_per_token/return_progress to streamed requests (needed for live stats). */
    injectStats: boolean
  }
  projects: {
    root: string
  }
  sandbox: {
    cpus: number
    memoryGb: number
    /** Podman storage root for LocalForge containers/images ('' = podman default). */
    podmanRoot: string
    screen: string
    computerUseCoords: 'pixels' | 'norm1000'
    /** Stop running sandboxes when LocalForge quits. */
    stopOnQuit: boolean
  }
  agent: {
    /** Ask before tool calls (edits, shell, web, desktop control). Off = auto-approve. */
    requireApproval: boolean
    autoCheckpoint: boolean
  }
  ui: {
    theme: 'dark' | 'light' | 'system'
    statsMode: 'compact' | 'detailed'
    stats: StatsToggles
  }
}

export function defaultSettings(cpuCount = 8): Settings {
  return {
    api: { active: '', providers: [] },
    llama: {
      baseUrl: 'http://127.0.0.1:8080',
      systemdUnit: 'llama.service',
      modelName: '',
      contextLimit: 65536,
      outputLimit: 16384,
      reasoningEffort: '',
      // Off: subagents run side by side, sharing the context memory. On only when the user chooses it.
      singleSlot: false,
    },
    proxy: { port: 8081, injectStats: true },
    projects: { root: '~/AIProjects' },
    sandbox: {
      cpus: Math.max(2, Math.min(8, Math.floor(cpuCount / 2))),
      memoryGb: 16,
      podmanRoot: '',
      screen: '1280x800',
      computerUseCoords: 'pixels',
      stopOnQuit: true,
    },
    agent: { requireApproval: false, autoCheckpoint: true },
    ui: {
      theme: 'dark',
      statsMode: 'detailed',
      stats: {
        thinking: true,
        liveStatus: true,
        promptProgress: true,
        messageFooter: true,
        contextMeter: true,
        totals: true,
        hardware: true,
      },
    },
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep-merge a partial settings object onto defaults (unknown keys are dropped, types kept). */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return base
  const out: Obj = { ...(base as Obj) }
  for (const [k, bv] of Object.entries(base as Obj)) {
    if (!(k in patch)) continue
    const pv = patch[k]
    if (isObj(bv)) out[k] = mergeSettings(bv, pv)
    else if (typeof pv === typeof bv) out[k] = pv
  }
  return out as T
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
