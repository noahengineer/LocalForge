import type {
  GenPhase,
  LlamaPromptProgress,
  LlamaTimings,
  LlamaUsage,
  LlmRequestStats,
  RequestKind,
} from '../../../shared/stats'

/**
 * Prompt-processing progress, following the llama.cpp web UI (ui/apps/chat,
 * use-processing-state): `processed` includes cached tokens, so progress is measured over the
 * tokens that actually need processing (done = processed - cache, todo = total - cache), and the
 * ETA extrapolates the average time per processed token so far:
 * eta = time_ms * (todo/done - 1). Like the web UI, no ETA is given before 500 ms of data.
 */
export function promptProgressOf(p: LlamaPromptProgress): { progress: number; etaMs: number | null } {
  const todo = Math.max(0, p.total - p.cache)
  const done = Math.max(0, p.processed - p.cache)
  if (todo <= 0) return { progress: 1, etaMs: 0 }
  const progress = Math.min(1, done / todo)
  let etaMs: number | null = null
  if (done > 0 && p.time_ms >= 500) {
    etaMs = Math.max(0, p.time_ms * (todo / done - 1))
  }
  return { progress, etaMs }
}

/** Classify a chat request so title/summary helper calls can be told apart from agent turns. */
export function classifyRequest(body: unknown): { kind: RequestKind; hasTools: boolean; messageCount: number } {
  const b = (body ?? {}) as { tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown }> }
  const hasTools = Array.isArray(b.tools) && b.tools.length > 0
  const messages = Array.isArray(b.messages) ? b.messages : []
  const systemText = messages
    .filter((m) => m && m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n')
  let kind: RequestKind = hasTools ? 'agent' : 'other'
  if (!hasTools) {
    if (/title generator|generate a (short )?title|conversation title/i.test(systemText)) kind = 'title'
    else if (/summar(y|ize|ise)|compact/i.test(systemText)) kind = 'summary'
  }
  return { kind, hasTools, messageCount: messages.length }
}

export interface TrackerOptions {
  id: string
  projectId: string | null
  body: unknown
  sessionId?: string | null
  parentSessionId?: string | null
  now?: () => number
}

/**
 * Tracks one streamed (or non-streamed) chat completion and maintains an LlmRequestStats
 * object from the llama.cpp-specific fields in each chunk.
 */
export class RequestTracker {
  readonly stats: LlmRequestStats
  private readonly now: () => number
  private lastPredictedN = 0

  constructor(opts: TrackerOptions) {
    this.now = opts.now ?? Date.now
    const cls = classifyRequest(opts.body)
    const b = (opts.body ?? {}) as { model?: string; stream?: boolean }
    this.stats = {
      id: opts.id,
      projectId: opts.projectId,
      sessionId: opts.sessionId ?? null,
      parentSessionId: opts.parentSessionId ?? null,
      kind: cls.kind,
      model: typeof b.model === 'string' ? b.model : null,
      stream: b.stream === true,
      hasTools: cls.hasTools,
      messageCount: cls.messageCount,
      startedAt: this.now(),
      firstTokenAt: null,
      endedAt: null,
      phase: 'queued',
      promptTotal: null,
      promptCached: null,
      promptProcessed: null,
      promptProgress: null,
      promptEtaMs: null,
      promptMs: null,
      promptPerSecond: null,
      predictedN: 0,
      predictedMs: 0,
      predictedPerSecond: null,
      reasoningTokens: 0,
      contentTokens: 0,
      toolTokens: 0,
      toolCalls: 0,
      reasoningStartAt: null,
      reasoningEndAt: null,
      timings: null,
      usage: null,
      finishReason: null,
      httpStatus: null,
      error: null,
    }
  }

  setHttpStatus(code: number): void {
    this.stats.httpStatus = code
  }

  /**
   * Feed one parsed chunk (a streamed `chat.completion.chunk` or a full non-streamed
   * `chat.completion` response). Returns true if anything changed.
   */
  onChunk(chunk: unknown): boolean {
    if (!chunk || typeof chunk !== 'object') return false
    const c = chunk as {
      choices?: Array<{
        delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string }> }
        message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown[] }
        finish_reason?: string | null
      }>
      timings?: LlamaTimings
      prompt_progress?: LlamaPromptProgress
      usage?: LlamaUsage
      error?: { message?: string } | string
    }
    const s = this.stats
    const t = this.now()

    if (c.error) {
      s.error = typeof c.error === 'string' ? c.error : (c.error.message ?? JSON.stringify(c.error))
      s.phase = 'error'
      return true
    }

    if (c.prompt_progress) {
      const p = c.prompt_progress
      s.promptTotal = p.total
      s.promptCached = p.cache
      s.promptProcessed = p.processed
      const { progress, etaMs } = promptProgressOf(p)
      s.promptProgress = progress
      s.promptEtaMs = etaMs
      if (s.phase === 'queued') s.phase = 'prompt'
    }

    // Determine what kind of token(s) this chunk carries.
    let carries: 'reasoning' | 'content' | 'tool' | null = null
    const choice = c.choices?.[0]
    if (choice) {
      const d = choice.delta ?? choice.message
      if (d) {
        if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) {
          carries = 'tool'
          if (choice.delta) {
            // A new tool call starts when an entry carries an id.
            for (const tc of choice.delta.tool_calls ?? []) if (tc && tc.id) s.toolCalls++
          } else {
            s.toolCalls += d.tool_calls.length
          }
        } else if (typeof d.reasoning_content === 'string' && d.reasoning_content.length > 0) {
          carries = 'reasoning'
        } else if (typeof d.content === 'string' && d.content.length > 0) {
          carries = 'content'
        }
      }
      if (choice.finish_reason) s.finishReason = choice.finish_reason
    }

    if (carries) {
      if (s.firstTokenAt === null) s.firstTokenAt = t
      if (carries === 'reasoning') {
        if (s.reasoningStartAt === null) s.reasoningStartAt = t
        s.phase = 'thinking'
      } else {
        if (s.reasoningStartAt !== null && s.reasoningEndAt === null) s.reasoningEndAt = t
        s.phase = carries === 'tool' ? 'tool' : 'writing'
      }
    }

    if (c.timings) {
      const tm = c.timings
      s.timings = tm
      if (typeof tm.prompt_ms === 'number' && tm.prompt_ms > 0) s.promptMs = tm.prompt_ms
      if (typeof tm.prompt_per_second === 'number' && tm.prompt_per_second > 0) s.promptPerSecond = tm.prompt_per_second
      if (typeof tm.predicted_n === 'number') {
        const n = tm.predicted_n
        const inc = Math.max(0, n - this.lastPredictedN)
        if (inc > 0) {
          // Attribute newly generated tokens to the phase of this chunk (or the current phase
          // for chunks that carry no visible delta, e.g. the final usage chunk / EOS token).
          const bucket = carries ?? (s.phase === 'thinking' ? 'reasoning' : s.phase === 'tool' ? 'tool' : 'content')
          if (bucket === 'reasoning') s.reasoningTokens += inc
          else if (bucket === 'tool') s.toolTokens += inc
          else s.contentTokens += inc
        }
        this.lastPredictedN = Math.max(this.lastPredictedN, n)
        s.predictedN = this.lastPredictedN
      }
      if (typeof tm.predicted_ms === 'number') s.predictedMs = tm.predicted_ms
      if (typeof tm.predicted_per_second === 'number' && tm.predicted_per_second > 0) s.predictedPerSecond = tm.predicted_per_second
      if (typeof tm.cache_n === 'number' && typeof tm.prompt_n === 'number') {
        // Once generation timings arrive the prompt is fully processed.
        if (tm.predicted_n && tm.predicted_n > 0) {
          s.promptCached = tm.cache_n
          s.promptTotal = tm.cache_n + tm.prompt_n
          s.promptProcessed = s.promptTotal
          s.promptProgress = 1
          s.promptEtaMs = 0
        }
      }
    }

    if (c.usage) s.usage = c.usage
    return true
  }

  /** Mark the request finished. `aborted` = the client disconnected before the end. */
  finish(opts: { aborted?: boolean; error?: string } = {}): LlmRequestStats {
    const s = this.stats
    s.endedAt = this.now()
    if (s.reasoningStartAt !== null && s.reasoningEndAt === null) s.reasoningEndAt = s.endedAt
    if (opts.error) {
      s.error = opts.error
      s.phase = 'error'
    } else if (opts.aborted && s.phase !== 'error') {
      s.phase = 'aborted'
    } else if (s.phase !== 'error') {
      s.phase = 'done'
    }
    // Prefer the server's final, authoritative counts when present.
    const u = s.usage
    if (u && typeof u.completion_tokens === 'number' && u.completion_tokens > s.predictedN) {
      const extra = u.completion_tokens - s.predictedN
      s.contentTokens += extra
      s.predictedN = u.completion_tokens
    }
    if (s.timings && typeof s.timings.cache_n === 'number' && typeof s.timings.prompt_n === 'number') {
      s.promptCached = s.timings.cache_n
      s.promptTotal = s.timings.cache_n + s.timings.prompt_n
      s.promptProcessed = s.promptTotal
      s.promptProgress = 1
      s.promptEtaMs = 0
    }
    return s
  }
}

/** Phase label shown in the UI's live status line. */
export function phaseLabel(p: GenPhase): string {
  switch (p) {
    case 'queued':
      return 'Waiting for model'
    case 'prompt':
      return 'Processing prompt'
    case 'thinking':
      return 'Thinking'
    case 'writing':
      return 'Writing'
    case 'tool':
      return 'Calling tool'
    case 'done':
      return 'Done'
    case 'error':
      return 'Error'
    case 'aborted':
      return 'Stopped'
  }
}
