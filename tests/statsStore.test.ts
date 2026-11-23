import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StatsStore, tokensMatch } from '../src/main/backend/statsStore'
import { addToTotals, messageStatsOf } from '../src/shared/statsMath'
import { emptyTotals, type LlmRequestStats } from '../src/shared/stats'

let n = 0
function req(p: Partial<LlmRequestStats>): LlmRequestStats {
  n++
  return {
    id: `req_${n}`,
    projectId: 'p1',
    sessionId: 'ses_1',
    parentSessionId: null,
    kind: 'agent',
    model: 'm',
    stream: true,
    hasTools: true,
    messageCount: 3,
    startedAt: 1000 * n,
    firstTokenAt: 1000 * n + 300,
    endedAt: 1000 * n + 900,
    phase: 'done',
    promptTotal: 15000,
    promptCached: 14000,
    promptProcessed: 15000,
    promptProgress: 1,
    promptEtaMs: 0,
    promptMs: 2000,
    promptPerSecond: 500,
    predictedN: 100,
    predictedMs: 10000,
    predictedPerSecond: 10,
    reasoningTokens: 40,
    contentTokens: 60,
    toolTokens: 0,
    toolCalls: 1,
    reasoningStartAt: 1000 * n + 300,
    reasoningEndAt: 1000 * n + 600,
    timings: { prompt_n: 1000, cache_n: 14000, predicted_n: 100, prompt_ms: 2000, predicted_ms: 10000 },
    usage: { prompt_tokens: 15000, completion_tokens: 100, total_tokens: 15100, prompt_tokens_details: { cached_tokens: 14000 } },
    finishReason: 'stop',
    httpStatus: 200,
    error: null,
    ...p,
  }
}

describe('tokensMatch', () => {
  it('maps OpenCode tokens (input excludes cache) onto llama usage', () => {
    const r = req({})
    expect(tokensMatch(r, { input: 1000, output: 100, reasoning: 0, cache: { read: 14000, write: 0 } })).toBe(true)
    expect(tokensMatch(r, { input: 1000, output: 99, reasoning: 0, cache: { read: 14000 } })).toBe(false)
    expect(tokensMatch(req({ usage: null }), { input: 0, output: 0, reasoning: 0 })).toBe(false)
  })
})

describe('messageStatsOf', () => {
  it('uses llama-server speeds verbatim for a single request', () => {
    const s = messageStatsOf([req({ predictedPerSecond: 7.35, promptPerSecond: 563.9 })])
    expect(s.genPerSecond).toBe(7.35)
    expect(s.promptPerSecond).toBe(563.9)
    expect(s.promptTokens).toBe(15000)
    expect(s.cachedTokens).toBe(14000)
    expect(s.processedPromptTokens).toBe(1000)
    expect(s.reasoningTokens).toBe(40)
    expect(s.outputTokens).toBe(100)
    expect(s.ttftMs).toBe(300)
    expect(s.totalMs).toBe(900)
    expect(s.steps).toBe(1)
  })
  it('token-weights speeds over several requests', () => {
    const s = messageStatsOf([req({ predictedN: 100, predictedMs: 10000 }), req({ predictedN: 300, predictedMs: 10000, promptTotal: 16000 })])
    expect(s.genPerSecond).toBeCloseTo(20)
    expect(s.outputTokens).toBe(400)
    expect(s.promptTokens).toBe(16000) // last request's context
  })
})

describe('totals', () => {
  it('sums processed, cached and generated tokens and time', () => {
    const t = addToTotals(addToTotals(emptyTotals(), req({})), req({ toolCalls: 2 }))
    expect(t).toMatchObject({ requests: 2, promptTokens: 2000, cachedTokens: 28000, outputTokens: 200, reasoningTokens: 80, genMs: 20000, toolCalls: 3 })
  })
})

describe('StatsStore', () => {
  it('links requests to OpenCode messages by exact token match and persists links', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lf-stats-'))
    const store = new StatsStore(dir)
    const a = req({ usage: { prompt_tokens: 15000, completion_tokens: 64 } })
    const b = req({ usage: { prompt_tokens: 15100, completion_tokens: 62 } })
    const other = req({ sessionId: 'ses_2', usage: { prompt_tokens: 15100, completion_tokens: 62 } })
    store.add(a)
    store.add(b)
    store.add(other)
    // Messages arrive in any order; matching uses the session + tokens.
    expect(store.linkMessage('p1', 'ses_1', 'msg_B', { input: 100, output: 62, reasoning: 0, cache: { read: 15000 } }, null)?.id).toBe(b.id)
    expect(store.linkMessage('p1', 'ses_1', 'msg_A', { input: 15000, output: 64, reasoning: 0, cache: { read: 0 } }, null)?.id).toBe(a.id)
    expect(store.linkMessage('p1', 'ses_1', 'msg_A', null, null)?.id).toBe(a.id) // idempotent
    const reloaded = new StatsStore(dir)
    const stats = reloaded.sessionMessageStats('p1', 'ses_1')
    expect(Object.keys(stats).sort()).toEqual(['msg_A', 'msg_B'])
    expect(stats.msg_B.requests[0].id).toBe(b.id)
    expect(reloaded.totals('p1', 'ses_1').session.requests).toBe(2)
    expect(reloaded.totals('p1', 'ses_1').project.requests).toBe(3)
  })

  it('falls back to the latest unlinked aborted request of the session', () => {
    const store = new StatsStore(mkdtempSync(path.join(os.tmpdir(), 'lf-stats-')))
    const ab = req({ phase: 'aborted', usage: null, startedAt: 5000 })
    store.add(ab)
    expect(store.linkMessage('p1', 'ses_1', 'msg_X', { input: 0, output: 0, reasoning: 0 }, 9000)?.id).toBe(ab.id)
  })

  it('counts subagent requests in the parent session totals', () => {
    const store = new StatsStore(mkdtempSync(path.join(os.tmpdir(), 'lf-stats-')))
    store.add(req({ sessionId: 'ses_child', parentSessionId: 'ses_1' }))
    store.add(req({}))
    expect(store.totals('p1', 'ses_1').session.requests).toBe(2)
  })
})
