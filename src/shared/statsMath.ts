/** Pure stats aggregation shared by the backend and the UI. */
import type { LlmRequestStats, MessageStats, TotalsStats } from './stats'

/** Aggregate the LLM requests behind one assistant message. */
export function messageStatsOf(reqs: LlmRequestStats[]): MessageStats {
  const sorted = [...reqs].sort((a, b) => a.startedAt - b.startedAt)
  const last = sorted[sorted.length - 1]
  let processed = 0
  let promptMs = 0
  let genN = 0
  let genMs = 0
  let reasoning = 0
  let output = 0
  let tools = 0
  for (const r of sorted) {
    const promptN = typeof r.timings?.prompt_n === 'number' ? r.timings.prompt_n : Math.max(0, (r.promptTotal ?? 0) - (r.promptCached ?? 0))
    processed += promptN
    promptMs += r.promptMs ?? 0
    genN += r.predictedN
    genMs += r.predictedMs
    reasoning += r.reasoningTokens
    output += r.predictedN
    tools += r.toolCalls
  }
  const first = sorted[0]
  // Speeds: for a single request, use llama-server's own reported numbers verbatim so they
  // match its logs; for several, compute the token-weighted average.
  const promptPerSecond = sorted.length === 1 ? (first?.promptPerSecond ?? null) : promptMs > 0 ? (processed / promptMs) * 1000 : null
  const genPerSecond = sorted.length === 1 ? (first?.predictedPerSecond ?? null) : genMs > 0 ? (genN / genMs) * 1000 : null
  return {
    promptTokens: last ? (last.promptTotal ?? 0) : 0,
    cachedTokens: last ? (last.promptCached ?? 0) : 0,
    processedPromptTokens: processed,
    reasoningTokens: reasoning,
    outputTokens: output,
    promptPerSecond,
    genPerSecond,
    ttftMs: first && first.firstTokenAt ? first.firstTokenAt - first.startedAt : null,
    totalMs: first && last ? (last.endedAt ?? Date.now()) - first.startedAt : 0,
    steps: sorted.length,
    toolCalls: tools,
  }
}

export function addToTotals(t: TotalsStats, r: LlmRequestStats): TotalsStats {
  const promptN = typeof r.timings?.prompt_n === 'number' ? r.timings.prompt_n : Math.max(0, (r.promptTotal ?? 0) - (r.promptCached ?? 0))
  return {
    requests: t.requests + 1,
    promptTokens: t.promptTokens + promptN,
    cachedTokens: t.cachedTokens + (r.promptCached ?? 0),
    outputTokens: t.outputTokens + r.predictedN,
    reasoningTokens: t.reasoningTokens + r.reasoningTokens,
    genMs: t.genMs + r.predictedMs,
    promptMs: t.promptMs + (r.promptMs ?? 0),
    toolCalls: t.toolCalls + r.toolCalls,
  }
}

