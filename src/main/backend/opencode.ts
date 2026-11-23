import { EventEmitter } from 'node:events'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import type { OcMessage, OcSession, PermissionRequest, QuestionRequest } from '../../shared/api'

export const WORKSPACE = '/workspace'
export const OC_USER = 'opencode'

export interface OcEvent {
  type: string
  properties: any
}

/** Unwrap a hey-api SDK result: throw on error, return data. */
function unwrap<T>(r: { data?: T; error?: unknown; response?: Response }, what: string): T {
  if (r.error !== undefined && r.error !== null) {
    const e = r.error as { message?: string; data?: { message?: string }; _tag?: string }
    const msg = e?.data?.message ?? e?.message ?? (typeof r.error === 'string' ? r.error : JSON.stringify(r.error))
    throw new Error(`OpenCode ${what} failed${r.response ? ` (HTTP ${r.response.status})` : ''}: ${msg}`)
  }
  return r.data as T
}

/**
 * Connection to one project's `opencode serve` (inside its sandbox), using the official SDK
 * (v2 client) over HTTP + SSE. Basic auth with the per-container password.
 */
export class OpenCodeConnection extends EventEmitter<{ event: [OcEvent]; connection: [boolean] }> {
  readonly client: OpencodeClient
  readonly authHeader: string
  private abort: AbortController | null = null
  private stopped = false
  connected = false

  constructor(
    readonly baseUrl: string,
    password: string,
  ) {
    super()
    this.authHeader = 'Basic ' + Buffer.from(`${OC_USER}:${password}`).toString('base64')
    this.client = createOpencodeClient({ baseUrl, directory: WORKSPACE, headers: { Authorization: this.authHeader } })
  }

  async health(timeoutMs = 3000): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/global/health`, {
        headers: { Authorization: this.authHeader },
        signal: AbortSignal.timeout(timeoutMs),
      })
      return r.ok
    } catch {
      return false
    }
  }

  async waitHealthy(timeoutMs = 90_000): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await this.health()) return
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`OpenCode server at ${this.baseUrl} did not become healthy within ${Math.round(timeoutMs / 1000)}s`)
  }

  /** Start the SSE event loop (reconnects automatically until stop()). */
  startEvents(): void {
    if (this.abort) return
    this.stopped = false
    void this.eventLoop()
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
    this.abort = null
    this.setConnected(false)
  }

  private setConnected(v: boolean): void {
    if (this.connected !== v) {
      this.connected = v
      this.emit('connection', v)
    }
  }

  private async eventLoop(): Promise<void> {
    let backoff = 500
    while (!this.stopped) {
      const ctrl = new AbortController()
      this.abort = ctrl
      try {
        const res = await this.client.event.subscribe({ directory: WORKSPACE }, { signal: ctrl.signal, sseMaxRetryAttempts: 0 } as never)
        for await (const ev of res.stream as AsyncIterable<OcEvent>) {
          if (this.stopped) break
          if (!this.connected) {
            this.setConnected(true)
            backoff = 500
          }
          if (ev && typeof ev.type === 'string') this.emit('event', ev)
        }
      } catch {
        /* connection dropped */
      }
      this.setConnected(false)
      if (this.stopped) break
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 5000)
    }
  }

  // --- Sessions & messages -------------------------------------------------------------------

  async listSessions(): Promise<OcSession[]> {
    return unwrap(await this.client.session.list({ directory: WORKSPACE }), 'session.list') as unknown as OcSession[]
  }

  async createSession(title?: string): Promise<OcSession> {
    return unwrap(await this.client.session.create({ directory: WORKSPACE, title }), 'session.create') as unknown as OcSession
  }

  async getSession(sessionID: string): Promise<OcSession> {
    return unwrap(await this.client.session.get({ sessionID, directory: WORKSPACE }), 'session.get') as unknown as OcSession
  }

  async deleteSession(sessionID: string): Promise<void> {
    unwrap(await this.client.session.delete({ sessionID, directory: WORKSPACE }), 'session.delete')
  }

  async renameSession(sessionID: string, title: string): Promise<void> {
    unwrap(await this.client.session.update({ sessionID, directory: WORKSPACE, title }), 'session.update')
  }

  async messages(sessionID: string): Promise<OcMessage[]> {
    return unwrap(await this.client.session.messages({ sessionID, directory: WORKSPACE }), 'session.messages') as unknown as OcMessage[]
  }

  async status(): Promise<Record<string, { type: string }>> {
    return unwrap(await this.client.session.status({ directory: WORKSPACE }), 'session.status') as Record<string, { type: string }>
  }

  async promptAsync(input: {
    sessionID: string
    agent: string
    parts: Array<Record<string, unknown>>
    model?: { providerID: string; modelID: string }
  }): Promise<void> {
    const r = await this.client.session.promptAsync({
      sessionID: input.sessionID,
      directory: WORKSPACE,
      agent: input.agent,
      model: input.model,
      parts: input.parts as never,
    })
    unwrap(r, 'session.promptAsync')
  }

  async abortSession(sessionID: string): Promise<void> {
    unwrap(await this.client.session.abort({ sessionID, directory: WORKSPACE }), 'session.abort')
  }

  async revert(sessionID: string, messageID: string): Promise<OcSession> {
    return unwrap(await this.client.session.revert({ sessionID, directory: WORKSPACE, messageID }), 'session.revert') as unknown as OcSession
  }

  async unrevert(sessionID: string): Promise<void> {
    unwrap(await this.client.session.unrevert({ sessionID, directory: WORKSPACE }), 'session.unrevert')
  }

  // --- Permissions & questions ---------------------------------------------------------------

  async replyPermission(requestID: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    unwrap(await this.client.permission.reply({ requestID, directory: WORKSPACE, reply, message }), 'permission.reply')
  }

  async listPermissions(): Promise<PermissionRequest[]> {
    return unwrap(await this.client.permission.list({ directory: WORKSPACE }), 'permission.list') as unknown as PermissionRequest[]
  }

  async replyQuestion(requestID: string, answers: string[][]): Promise<void> {
    unwrap(await this.client.question.reply({ requestID, directory: WORKSPACE, answers }), 'question.reply')
  }

  async rejectQuestion(requestID: string): Promise<void> {
    unwrap(await this.client.question.reject({ requestID, directory: WORKSPACE }), 'question.reject')
  }

  async listQuestions(): Promise<QuestionRequest[]> {
    return unwrap(await this.client.question.list({ directory: WORKSPACE }), 'question.list') as unknown as QuestionRequest[]
  }

  // --- Files ------------------------------------------------------------------------------------

  async findFiles(query: string, limit = 50): Promise<string[]> {
    const r = await this.client.find.files({ directory: WORKSPACE, query, limit, dirs: 'false' })
    return unwrap(r, 'find.files') as string[]
  }

  // --- PTY (terminal inside the sandbox) -------------------------------------------------------

  async ptyCreate(cols: number, rows: number): Promise<string> {
    const r = await this.client.pty.create({
      directory: WORKSPACE,
      command: '/bin/bash',
      args: ['-l'],
      cwd: WORKSPACE,
      title: 'LocalForge terminal',
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
    const pty = unwrap(r, 'pty.create') as { id: string }
    await this.ptyResize(pty.id, cols, rows).catch(() => {})
    return pty.id
  }

  async ptyResize(ptyID: string, cols: number, rows: number): Promise<void> {
    unwrap(await this.client.pty.update({ ptyID, directory: WORKSPACE, size: { cols, rows } }), 'pty.update')
  }

  async ptyRemove(ptyID: string): Promise<void> {
    unwrap(await this.client.pty.remove({ ptyID, directory: WORKSPACE }), 'pty.remove')
  }

  /**
   * Open the PTY websocket. OpenCode requires a short-lived ticket requested with the
   * `x-opencode-ticket: 1` header; the websocket then authenticates with `?ticket=`.
   * Output frames are UTF-8 text; a binary frame starting with 0x00 carries {cursor} metadata.
   */
  async ptyConnect(ptyID: string, onData: (s: string) => void, onClose: () => void): Promise<{ send: (s: string) => void; close: () => void }> {
    const dir = encodeURIComponent(WORKSPACE)
    const tr = await fetch(`${this.baseUrl}/pty/${ptyID}/connect-token?directory=${dir}`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'x-opencode-ticket': '1' },
    })
    if (!tr.ok) throw new Error(`pty connect-token: HTTP ${tr.status} ${await tr.text()}`)
    const { ticket } = (await tr.json()) as { ticket: string }
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/pty/${ptyID}/connect?directory=${dir}&ticket=${encodeURIComponent(ticket)}`
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    const decoder = new TextDecoder()
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('pty websocket failed to open'))
    })
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') onData(e.data)
      else {
        const bytes = new Uint8Array(e.data as ArrayBuffer)
        if (bytes[0] === 0) return // metadata frame
        onData(decoder.decode(bytes))
      }
    }
    ws.onclose = () => onClose()
    ws.onerror = () => {}
    return {
      send: (s: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(s)
      },
      close: () => ws.close(),
    }
  }
}
