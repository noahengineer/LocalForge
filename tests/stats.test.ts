import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SseParser, type SseEvent } from '../src/main/backend/stats/sse'
import { classifyRequest, promptProgressOf, RequestTracker } from '../src/main/backend/stats/tracker'

const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

function parseAll(text: string, chunkSize?: number): SseEvent[] {
  const evs: SseEvent[] = []
  const p = new SseParser((e) => evs.push(e))
  const bytes = new TextEncoder().encode(text)
  if (!chunkSize) p.push(bytes)
  else for (let i = 0; i < bytes.length; i += chunkSize) p.push(bytes.subarray(i, i + chunkSize))
  p.end()
  return evs
}

describe('SseParser', () => {
  it('parses data events, ignores comments, joins multi-line data', () => {
    const evs = parseAll(': ping\n\ndata: {"a":1}\n\nevent: x\nid: 7\ndata: line1\ndata: line2\n\n')
    expect(evs).toEqual([{ data: '{"a":1}' }, { event: 'x', id: '7', data: 'line1\nline2' }])
  })

  it('handles CRLF and CR line endings', () => {
    expect(parseAll('data: a\r\n\r\ndata: b\r\rdata: c\n\n').map((e) => e.data)).toEqual(['a', 'b', 'c'])
  })

  it('is independent of chunk boundaries, including split UTF-8 characters', () => {
    const text = 'data: {"t":"héllo → 世界 🚀"}\n\ndata: [DONE]\n\n'
    const whole = parseAll(text)
    for (const size of [1, 2, 3, 5, 7]) expect(parseAll(text, size)).toEqual(whole)
    expect(JSON.parse(whole[0].data).t).toBe('héllo → 世界 🚀')
  })

  it('flushes a final event without a trailing blank line', () => {
    expect(parseAll('data: last').map((e) => e.data)).toEqual(['last'])
  })

  it('parses a real llama-server stream fixture', () => {
    const evs = parseAll(fixture('llama-stream-reasoning.txt'), 61)
    expect(evs[evs.length - 1].data).toBe('[DONE]')
    for (const e of evs.slice(0, -1)) expect(() => JSON.parse(e.data)).not.toThrow()
  })
})

describe('promptProgressOf (llama.cpp web UI formula)', () => {
  it('excludes cached tokens and extrapolates the ETA', () => {
    // 1000 cached, 3000 to process, 1500 processed so far in 3s -> 50%, 3s left.
    const r = promptProgressOf({ total: 4000, cache: 1000, processed: 2500, time_ms: 3000 })
    expect(r.progress).toBeCloseTo(0.5)
    expect(r.etaMs).toBeCloseTo(3000)
  })
  it('gives no ETA before 500 ms or before any progress', () => {
    expect(promptProgressOf({ total: 100, cache: 0, processed: 10, time_ms: 400 }).etaMs).toBeNull()
    expect(promptProgressOf({ total: 100, cache: 0, processed: 0, time_ms: 900 }).etaMs).toBeNull()
  })
  it('is complete when everything is cached', () => {
    expect(promptProgressOf({ total: 50, cache: 50, processed: 50, time_ms: 0 })).toEqual({ progress: 1, etaMs: 0 })
  })
})

describe('classifyRequest', () => {
  it('marks tool-using requests as agent turns and detects helper calls', () => {
    expect(classifyRequest({ tools: [{}], messages: [{ role: 'user', content: 'x' }] }).kind).toBe('agent')
    expect(classifyRequest({ messages: [{ role: 'system', content: 'You are a title generator.' }] }).kind).toBe('title')
    expect(classifyRequest({ messages: [{ role: 'system', content: 'Summarize the conversation' }] }).kind).toBe('summary')
    expect(classifyRequest({ messages: [] }).kind).toBe('other')
  })
})

function track(fixtureName: string, body: unknown) {
  let now = 1_000_000
  const tr = new RequestTracker({ id: 'r1', projectId: 'p1', sessionId: 'ses_x', body, now: () => (now += 10) })
  for (const e of parseAll(fixture(fixtureName))) {
    if (e.data === '[DONE]') continue
    tr.onChunk(JSON.parse(e.data))
  }
  return { stats: tr.finish(), tr }
}

describe('RequestTracker on real llama-server streams', () => {
  it('separates reasoning from answer tokens and keeps llama-server final numbers', () => {
    const { stats } = track('llama-stream-reasoning.txt', { stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const final = JSON.parse(
      fixture('llama-stream-reasoning.txt')
        .split('\n')
        .filter((l) => l.includes('"usage"'))
        .pop()!
        .slice(6),
    )
    expect(stats.phase).toBe('done')
    expect(stats.sessionId).toBe('ses_x')
    expect(stats.usage).toEqual(final.usage)
    expect(stats.timings).toEqual(final.timings)
    // Token accounting adds up to llama-server's completion count.
    expect(stats.predictedN).toBe(final.usage.completion_tokens)
    expect(stats.reasoningTokens + stats.contentTokens + stats.toolTokens).toBe(final.usage.completion_tokens)
    expect(stats.reasoningTokens).toBeGreaterThan(0)
    expect(stats.contentTokens).toBeGreaterThan(0)
    // Speeds are llama-server's own numbers, verbatim.
    expect(stats.predictedPerSecond).toBe(final.timings.predicted_per_second)
    expect(stats.promptPerSecond).toBe(final.timings.prompt_per_second)
    expect(stats.promptTotal).toBe(final.timings.prompt_n + final.timings.cache_n)
    expect(stats.promptProgress).toBe(1)
    expect(stats.firstTokenAt).not.toBeNull()
    expect(stats.reasoningStartAt).not.toBeNull()
    expect(stats.reasoningEndAt).not.toBeNull()
  })

  it('counts tool calls and tool-call tokens', () => {
    const { stats } = track('llama-stream-toolcall.txt', { stream: true, tools: [{}], messages: [{ role: 'user', content: 'weather' }] })
    expect(stats.kind).toBe('agent')
    expect(stats.finishReason).toBe('tool_calls')
    expect(stats.toolCalls).toBe(1)
    expect(stats.toolTokens).toBeGreaterThan(0)
    expect(stats.predictedN).toBe(stats.usage?.completion_tokens)
  })

  it('reports prompt progress while processing', () => {
    const tr = new RequestTracker({ id: 'r', projectId: null, body: { stream: true } })
    tr.onChunk({ choices: [{ delta: { role: 'assistant', content: null } }], prompt_progress: { total: 10000, cache: 2000, processed: 6000, time_ms: 8000 } })
    expect(tr.stats.phase).toBe('prompt')
    expect(tr.stats.promptProgress).toBeCloseTo(0.5)
    expect(tr.stats.promptEtaMs).toBeCloseTo(8000)
  })

  it('marks aborted and errored requests', () => {
    const a = new RequestTracker({ id: 'a', projectId: null, body: {} })
    expect(a.finish({ aborted: true }).phase).toBe('aborted')
    const b = new RequestTracker({ id: 'b', projectId: null, body: {} })
    b.onChunk({ error: { message: 'boom' } })
    expect(b.finish().phase).toBe('error')
    expect(b.stats.error).toBe('boom')
  })
})
