import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { injectStats, isCompletionPath, routeOf, StatsProxy } from '../src/main/backend/stats/proxy'
import type { LlmRequestStats } from '../src/shared/stats'

const STREAM = readFileSync(path.join(__dirname, 'fixtures', 'llama-stream-reasoning.txt'), 'utf8')

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
  closedEarly: boolean
}

/** A fake llama-server: streams the recorded fixture slowly, answers JSON for other routes. */
function fakeLlama(opts: { delayMs?: number } = {}) {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const rec: Seen = { method: req.method!, url: req.url!, headers: req.headers, body, closedEarly: false }
      seen.push(rec)
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"ok"}')
        return
      }
      const parsed = body ? JSON.parse(body) : {}
      if (req.url === '/v1/chat/completions' && parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const lines = STREAM.split(/(?<=\n\n)/)
        let i = 0
        res.on('close', () => {
          if (i < lines.length) rec.closedEarly = true
        })
        const tick = () => {
          if (i >= lines.length) return res.end()
          res.write(lines[i++])
          setTimeout(tick, opts.delayMs ?? 0)
        }
        tick()
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'hi', reasoning_content: 'hmm' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 }, timings: { prompt_n: 5, cache_n: 0, predicted_n: 3, predicted_ms: 30, predicted_per_second: 100, prompt_ms: 10, prompt_per_second: 500 } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  return { server, seen }
}

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

describe('proxy helpers', () => {
  it('routes /p/<project>/... and passes other paths through', () => {
    expect(routeOf('/p/my-proj_1/v1/chat/completions')).toEqual({ projectId: 'my-proj_1', path: '/v1/chat/completions' })
    expect(routeOf('/v1/models')).toEqual({ projectId: null, path: '/v1/models' })
    expect(routeOf('/p/x')).toEqual({ projectId: 'x', path: '/' })
  })
  it('recognises completion endpoints', () => {
    expect(isCompletionPath('/v1/chat/completions')).toBe(true)
    expect(isCompletionPath('/v1/completions?x=1')).toBe(true)
    expect(isCompletionPath('/v1/models')).toBe(false)
  })
  it('adds llama.cpp stats fields only to streamed requests and never overrides the client', () => {
    expect(injectStats({ stream: true })).toEqual({ stream: true, timings_per_token: true, return_progress: true })
    expect(injectStats({ stream: false })).toEqual({ stream: false })
    expect(injectStats({ stream: true, return_progress: false })).toMatchObject({ return_progress: false })
  })
})

describe('StatsProxy', () => {
  let upstream: ReturnType<typeof fakeLlama>
  let proxy: StatsProxy
  let base: string
  const events: Array<[string, LlmRequestStats]> = []

  beforeEach(async () => {
    events.length = 0
    upstream = fakeLlama()
    const up = await listen(upstream.server)
    proxy = new StatsProxy({ port: 0, upstream: `http://127.0.0.1:${up}`, updateIntervalMs: 0 })
    for (const t of ['start', 'update', 'end'] as const) proxy.on(t, (s) => events.push([t, s]))
    await proxy.start()
    base = `http://127.0.0.1:${proxy.port}`
  })
  afterEach(async () => {
    await proxy.stop()
    upstream.server.closeAllConnections()
    await new Promise((r) => upstream.server.close(r))
  })

  it('forwards the streamed response byte-for-byte and reports stats', async () => {
    const r = await fetch(`${base}/p/proj1/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-session-id': 'ses_abc' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    const text = await r.text()
    expect(text).toBe(STREAM) // unchanged
    await new Promise((res) => setTimeout(res, 20))
    // Upstream saw the project prefix stripped and the stats fields added.
    const seen = upstream.seen.find((s) => s.url === '/v1/chat/completions')!
    expect(JSON.parse(seen.body)).toMatchObject({ stream: true, timings_per_token: true, return_progress: true, model: 'm' })
    const kinds = events.map((e) => e[0])
    expect(kinds[0]).toBe('start')
    expect(kinds).toContain('update')
    expect(kinds[kinds.length - 1]).toBe('end')
    const end = events[events.length - 1][1]
    expect(end.projectId).toBe('proj1')
    expect(end.sessionId).toBe('ses_abc')
    expect(end.phase).toBe('done')
    expect(end.usage?.completion_tokens).toBe(end.predictedN)
    expect(proxy.active.size).toBe(0)
  })

  it('passes non-completion requests through untouched', async () => {
    const r = await fetch(`${base}/health`)
    expect(await r.json()).toEqual({ status: 'ok' })
    expect(events).toHaveLength(0)
  })

  it('tracks non-streamed completions', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) })
    expect((await r.json()).choices[0].message.content).toBe('hi')
    await new Promise((res) => setTimeout(res, 20))
    const seen = upstream.seen.find((s) => s.url === '/v1/chat/completions')!
    expect(JSON.parse(seen.body)).not.toHaveProperty('timings_per_token')
    const end = events.find((e) => e[0] === 'end')![1]
    expect(end.predictedN).toBe(3)
    expect(end.predictedPerSecond).toBe(100)
  })

  it('cancels the upstream generation when the client disconnects (Stop button)', async () => {
    await proxy.stop()
    upstream.server.closeAllConnections()
    await new Promise((r) => upstream.server.close(r))
    upstream = fakeLlama({ delayMs: 40 })
    const up = await listen(upstream.server)
    proxy = new StatsProxy({ port: 0, upstream: `http://127.0.0.1:${up}`, updateIntervalMs: 0 })
    proxy.on('end', (s) => events.push(['end', s]))
    await proxy.start()
    const ctrl = new AbortController()
    const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [] }),
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
    })
    const reader = r.body!.getReader()
    await reader.read()
    ctrl.abort()
    await new Promise((res) => setTimeout(res, 300))
    expect(upstream.seen.find((s) => s.url === '/v1/chat/completions')!.closedEarly).toBe(true)
    expect(events.find((e) => e[0] === 'end')![1].phase).toBe('aborted')
  })

  it('returns 502 with a JSON error when llama-server is down', async () => {
    const p2 = new StatsProxy({ port: 0, upstream: 'http://127.0.0.1:1' })
    let end: LlmRequestStats | null = null
    p2.on('end', (s) => (end = s))
    await p2.start()
    const r = await fetch(`http://127.0.0.1:${p2.port}/v1/chat/completions`, { method: 'POST', body: '{"stream":true}', headers: { 'content-type': 'application/json' } })
    expect(r.status).toBe(502)
    expect((await r.json()).error.type).toBe('proxy_error')
    expect(end!.phase).toBe('error')
    await p2.stop()
  })
})
