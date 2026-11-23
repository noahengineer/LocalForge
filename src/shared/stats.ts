/** Types for live model statistics, shared by the backend (stats proxy) and the UI. */

/** Raw `timings` object as reported by llama-server. */
export interface LlamaTimings {
  cache_n?: number
  prompt_n?: number
  prompt_ms?: number
  prompt_per_token_ms?: number
  prompt_per_second?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_token_ms?: number
  predicted_per_second?: number
  [k: string]: unknown
}

/** Raw `prompt_progress` object as reported by llama-server when `return_progress` is on. */
export interface LlamaPromptProgress {
  total: number
  cache: number
  processed: number
  time_ms: number
}

export interface LlamaUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  [k: string]: unknown
}

export type GenPhase =
  | 'queued' // request received, nothing from the server yet
  | 'prompt' // processing the prompt
  | 'thinking' // generating reasoning tokens
  | 'writing' // generating answer text
  | 'tool' // generating a tool call
  | 'done'
  | 'error'
  | 'aborted'

export type RequestKind = 'agent' | 'title' | 'summary' | 'other'

/** Live + final statistics for one LLM request that went through the stats proxy. */
export interface LlmRequestStats {
  id: string
  projectId: string | null
  /** OpenCode session that made the request (from the x-opencode-session-id header). */
  sessionId: string | null
  /** Parent session for subagent requests (x-parent-session-id). */
  parentSessionId: string | null
  kind: RequestKind
  model: string | null
  stream: boolean
  hasTools: boolean
  messageCount: number
  /** Wall-clock ms (epoch) when the proxy received the request. */
  startedAt: number
  /** Wall-clock ms when the first generated token (reasoning, text or tool call) arrived. */
  firstTokenAt: number | null
  endedAt: number | null
  phase: GenPhase

  // Prompt processing (from prompt_progress / timings)
  promptTotal: number | null
  promptCached: number | null
  promptProcessed: number | null
  /** 0..1 progress over the tokens that actually need processing (excludes cache hits). */
  promptProgress: number | null
  promptEtaMs: number | null
  promptMs: number | null
  promptPerSecond: number | null

  // Generation
  predictedN: number
  predictedMs: number
  predictedPerSecond: number | null
  reasoningTokens: number
  contentTokens: number
  toolTokens: number
  toolCalls: number
  reasoningStartAt: number | null
  reasoningEndAt: number | null

  // Final values reported by the server
  timings: LlamaTimings | null
  usage: LlamaUsage | null
  finishReason: string | null
  httpStatus: number | null
  error: string | null
}

/** Aggregated stats for one assistant message (may span several LLM calls / steps). */
export interface MessageStats {
  promptTokens: number // context size of the last step's prompt (cached + processed)
  cachedTokens: number // cached tokens of the last step
  processedPromptTokens: number // sum over steps of tokens actually processed
  reasoningTokens: number
  outputTokens: number // total generated tokens (incl. reasoning)
  promptPerSecond: number | null
  genPerSecond: number | null
  ttftMs: number | null
  totalMs: number
  steps: number
  toolCalls: number
}

export interface TotalsStats {
  requests: number
  promptTokens: number // tokens actually processed (excl. cache)
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  genMs: number
  promptMs: number
  toolCalls: number
}

export const emptyTotals = (): TotalsStats => ({
  requests: 0,
  promptTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  genMs: 0,
  promptMs: 0,
  toolCalls: 0,
})

export interface HardwareSample {
  t: number
  gpu: {
    name: string
    vramUsedMiB: number
    vramTotalMiB: number
    utilPct: number
    tempC: number
    powerW: number
    powerLimitW: number | null
  } | null
  cpuPct: number
  ramUsedMiB: number
  ramTotalMiB: number
  /** Live generation tokens/s at sample time (0 when idle). */
  tps: number
}

export interface LlamaServerStatus {
  up: boolean
  /** systemd ActiveState of the unit, if known. */
  unitState: string | null
  modelAlias: string | null
  nCtx: number | null
  totalSlots: number | null
  vision: boolean
  busySlots: number
  buildInfo: string | null
  /** Reasoning-effort levels the loaded model's chat template accepts (llama.cpp's chat_template_caps); null = unknown/none. */
  reasoningLevels: string[] | null
  /** The level the template uses when none is sent (parsed from the template), if known. */
  reasoningDefault: string | null
  error: string | null
}
