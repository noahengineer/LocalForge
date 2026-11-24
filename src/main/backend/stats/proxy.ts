import http from 'node:http'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { SseParser } from './sse'
import { RequestTracker } from './tracker'
import type { LlmRequestStats } from '../../../shared/stats'

export interface StatsProxyOptions {
  /** Address to listen on. Default 127.0.0.1. */
  host?: string
  /** Port to listen on. 0 = pick a free port. Default 8081. */
  port?: number
  /** Upstream llama-server base URL, e.g. http://127.0.0.1:8080 */
  upstream: string
  /**
   * Ask llama-server for its extra streaming stats (`timings_per_token`, `return_progress`)
   * on streamed chat requests. These only add llama.cpp-specific fields to the chunks; the
   * OpenAI-compatible fields the client relies on are untouched. Default true.
   */
  injectStatsFields?: boolean
  /** Last change to a chat request body before it is sent (e.g. the reasoning-effort setting). */
  rewriteBody?: (body: Record<string, unknown>) => Record<string, unknown>
  /** Minimum interval between 'update' events per request (ms). Default 100. */
  updateIntervalMs?: number
  /**
   * Send a chat request somewhere other than llama-server (an API model). Return null to use
   * llama-server, a route to forward it there instead, or an error to answer it directly.
   */
  route?: (body: Record<string, unknown>) => ApiRoute | { error: string; status: number } | null
}

/** Where an API model's request goes. */
export interface ApiRoute {
  /** Base URL, e.g. https://api.venice.ai/api/v1 (the request path's /v1 is replaced by it). */
  baseUrl: string
  apiKey: string
  body: Record<string, unknown>
}

/** Request headers passed on to an API: nothing that identifies the user's sessions or projects. */
const API_HEADERS = new Set(['content-type', 'accept', 'user-agent'])

export interface StatsProxyEvents {
  start: [LlmRequestStats]
  update: [LlmRequestStats]
  end: [LlmRequestStats]
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Split `/p/<projectId>/rest` into project id + upstream path. */
export function routeOf(url: string): { projectId: string | null; path: string } {
  const m = /^\/p\/([A-Za-z0-9_-]{1,64})(\/.*)?$/.exec(url)
  if (m) return { projectId: m[1], path: m[2] ?? '/' }
  return { projectId: null, path: url }
}

/** True for endpoints whose responses carry llama.cpp generation stats. */
export function isCompletionPath(path: string): boolean {
  const p = path.split('?')[0]
  return /\/(chat\/)?completions$/.test(p)
}

/** Add llama.cpp's stats fields to a streamed chat request body (returns a new object). */
export function injectStats(body: Record<string, unknown>): Record<string, unknown> {
  if (body.stream !== true) return body
  const out: Record<string, unknown> = { ...body }
  if (out.timings_per_token === undefined) out.timings_per_token = true
  if (out.return_progress === undefined) out.return_progress = true
  return out
}

function headerOf(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0] ?? null
  return typeof v === 'string' && v.length > 0 ? v : null
}

let counter = 0
const newId = () => `req_${Date.now().toString(36)}_${(counter++).toString(36)}`

export class StatsProxy extends EventEmitter<StatsProxyEvents> {
  private server: http.Server | null = null
  private upstream: URL
  private opts: Required<Omit<StatsProxyOptions, 'upstream'>>
  /** Requests currently in flight, by id. */
  readonly active = new Map<string, LlmRequestStats>()

  constructor(options: StatsProxyOptions) {
    super()
    this.upstream = new URL(options.upstream)
    this.opts = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 8081,
      injectStatsFields: options.injectStatsFields ?? true,
      updateIntervalMs: options.updateIntervalMs ?? 100,
      rewriteBody: options.rewriteBody ?? ((b) => b),
      route: options.route ?? (() => null),
    }
  }

  setUpstream(url: string): void {
    this.upstream = new URL(url)
  }

  /** Change the listen port (takes effect on the next start()). */
  setPort(port: number): void {
    this.opts.port = port
  }

  get port(): number | null {
    const a = this.server?.address() as AddressInfo | null
    return a ? a.port : null
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = http.createServer((req, res) => this.handle(req, res))
    server.keepAliveTimeout = 65_000
    server.requestTimeout = 0 // generations can take a long time
    server.headersTimeout = 70_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.port, this.opts.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (!s) return
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections?.()
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const { projectId, path } = routeOf(req.url ?? '/')
    const isCompletion = req.method === 'POST' && isCompletionPath(path)
    if (!isCompletion) {
      this.forward(req, res, path, null, null)
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('error', () => res.destroy())
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let body: Record<string, unknown> | null = null
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      } catch {
        body = null
      }
      if (!body) {
        this.forward(req, res, path, raw, null)
        return
      }
      const route = this.opts.route(body)
      if (route && 'error' in route) {
        res.writeHead(route.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: route.error, type: 'localforge_error' } }))
        return
      }
      const injected = this.opts.injectStatsFields ? injectStats(body) : body
      const sendBody = this.opts.rewriteBody(injected)
      const tracker = new RequestTracker({
        id: newId(),
        projectId,
        body,
        sessionId: headerOf(req, 'x-opencode-session-id') ?? headerOf(req, 'x-session-id'),
        parentSessionId: headerOf(req, 'x-parent-session-id'),
      })
      if (route) {
        // An API model: no llama.cpp fields, no reasoning-effort rewrite; the key is added here.
        this.forward(req, res, path, Buffer.from(JSON.stringify(route.body)), tracker, route)
        return
      }
      this.forward(req, res, path, Buffer.from(JSON.stringify(sendBody)), tracker)
    })
  }

  private forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    body: Buffer | null,
    tracker: RequestTracker | null,
    api?: ApiRoute,
  ): void {
    const up = api ? new URL(api.baseUrl) : this.upstream
    const basePath = up.pathname.replace(/\/$/, '')
    // An API's base URL already ends in its version (/api/v1), so drop the client's /v1.
    if (api) path = path.replace(/^\/v1(?=\/)/, '')
    const headers: http.OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue
      if (api && !API_HEADERS.has(k.toLowerCase())) continue
      headers[k] = v
    }
    if (api) headers.authorization = `Bearer ${api.apiKey}`
    headers.host = up.host
    if (body) {
      headers['content-length'] = String(body.length)
      delete headers['transfer-encoding']
    }
    // We need to parse the upstream stream, so ask for an uncompressed body.
    if (tracker) headers['accept-encoding'] = 'identity'

    const lib = up.protocol === 'https:' ? https : http
    let finished = false
    let lastEmit = 0
    let pendingEmit: NodeJS.Timeout | null = null

    const emitUpdate = (force = false) => {
      if (!tracker) return
      const now = Date.now()
      if (force || now - lastEmit >= this.opts.updateIntervalMs) {
        lastEmit = now
        if (pendingEmit) {
          clearTimeout(pendingEmit)
          pendingEmit = null
        }
        this.emit('update', { ...tracker.stats })
      } else if (!pendingEmit) {
        pendingEmit = setTimeout(() => {
          pendingEmit = null
          lastEmit = Date.now()
          if (!finished) this.emit('update', { ...tracker.stats })
        }, this.opts.updateIntervalMs - (now - lastEmit))
      }
    }

    const finish = (opts: { aborted?: boolean; error?: string } = {}) => {
      if (finished || !tracker) return
      finished = true
      if (pendingEmit) clearTimeout(pendingEmit)
      const final = tracker.finish(opts)
      this.active.delete(final.id)
      this.emit('end', { ...final })
    }

    if (tracker) {
      this.active.set(tracker.stats.id, tracker.stats)
      this.emit('start', { ...tracker.stats })
    }

    const upReq = lib.request(
      {
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port || (up.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: basePath + path,
        headers,
      },
      (upRes) => {
        const resHeaders: http.OutgoingHttpHeaders = {}
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue
          resHeaders[k] = v
        }
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, resHeaders)
        res.flushHeaders?.()
        if (!tracker) {
          upRes.pipe(res)
          return
        }
        tracker.setHttpStatus(upRes.statusCode ?? 0)
        const ctype = String(upRes.headers['content-type'] ?? '')
        const isSse = ctype.includes('text/event-stream')
        const jsonChunks: Buffer[] = []
        const parser = new SseParser((ev) => {
          if (ev.data === '[DONE]') return
          try {
            if (tracker.onChunk(JSON.parse(ev.data))) emitUpdate()
          } catch {
            /* ignore non-JSON data lines */
          }
        })
        upRes.on('data', (c: Buffer) => {
          res.write(c)
          if (isSse) parser.push(c)
          else jsonChunks.push(c)
        })
        upRes.on('end', () => {
          res.end()
          if (isSse) parser.end()
          else {
            try {
              tracker.onChunk(JSON.parse(Buffer.concat(jsonChunks).toString('utf8')))
            } catch {
              /* not JSON */
            }
          }
          const status = upRes.statusCode ?? 0
          finish(status >= 400 ? { error: `HTTP ${status}` } : {})
        })
        upRes.on('error', (e) => {
          finish({ error: e.message })
          res.destroy()
        })
      },
    )
    upReq.setTimeout(0)
    upReq.on('error', (e) => {
      finish({ error: `upstream: ${e.message}` })
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `LocalForge stats proxy: upstream unavailable (${e.message})`, type: 'proxy_error' } }))
      } else {
        res.destroy()
      }
    })
    // If the client goes away (e.g. the user pressed Stop), cancel the upstream request so
    // llama-server stops generating.
    res.on('close', () => {
      if (!res.writableFinished) {
        upReq.destroy()
        finish({ aborted: true })
      }
    })

    if (body) upReq.end(body)
    else req.pipe(upReq)
  }
}
