import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { emptyTotals, type LlmRequestStats, type MessageStats, type TotalsStats } from '../../shared/stats'
import { addToTotals, messageStatsOf } from '../../shared/statsMath'

export { addToTotals, messageStatsOf }

/** Token usage of an OpenCode assistant message (AssistantMessage.tokens). */
export interface OcTokens {
  input: number
  output: number
  reasoning: number
  cache?: { read?: number; write?: number }
}

/**
 * Does this proxy request correspond to the OpenCode assistant message with these tokens?
 * OpenCode (openai-compatible) reports input = prompt_tokens - cached, cache.read = cached,
 * output = completion_tokens (llama.cpp does not split out reasoning tokens).
 */
export function tokensMatch(req: LlmRequestStats, t: OcTokens): boolean {
  const u = req.usage
  if (!u || typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return false
  const prompt = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
  const output = (t.output ?? 0) + (t.reasoning ?? 0)
  return u.prompt_tokens === prompt && u.completion_tokens === output
}

type Record_ = { kind: 'req'; req: LlmRequestStats } | { kind: 'link'; requestId: string; messageId: string }

/**
 * Persists finished LLM requests per project (JSON lines) and links them to OpenCode assistant
 * messages so per-message stats survive restarts.
 */
export class StatsStore {
  private requests = new Map<string, LlmRequestStats[]>() // projectId -> requests (chronological)
  private links = new Map<string, Map<string, string>>() // projectId -> requestId -> messageId
  private loaded = new Set<string>()

  constructor(private readonly dir: string) {}

  private file(projectId: string): string {
    return path.join(this.dir, `${projectId}.jsonl`)
  }

  private load(projectId: string): void {
    if (this.loaded.has(projectId)) return
    this.loaded.add(projectId)
    const reqs: LlmRequestStats[] = []
    const links = new Map<string, string>()
    const f = this.file(projectId)
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line) as Record_
          if (rec.kind === 'req') reqs.push(rec.req)
          else if (rec.kind === 'link') links.set(rec.requestId, rec.messageId)
        } catch {
          /* skip corrupt line */
        }
      }
    }
    this.requests.set(projectId, reqs)
    this.links.set(projectId, links)
  }

  private append(projectId: string, rec: Record_): void {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.file(projectId), JSON.stringify(rec) + '\n')
  }

  /** Record a finished request. */
  add(req: LlmRequestStats): void {
    if (!req.projectId) return
    this.load(req.projectId)
    this.requests.get(req.projectId)!.push(req)
    this.append(req.projectId, { kind: 'req', req })
  }

  all(projectId: string): LlmRequestStats[] {
    this.load(projectId)
    return this.requests.get(projectId)!
  }

  messageOf(projectId: string, requestId: string): string | null {
    this.load(projectId)
    return this.links.get(projectId)!.get(requestId) ?? null
  }

  private link(projectId: string, requestId: string, messageId: string): void {
    this.links.get(projectId)!.set(requestId, messageId)
    this.append(projectId, { kind: 'link', requestId, messageId })
  }

  /**
   * Link an OpenCode assistant message to the request that produced it. Prefers an exact token
   * match within the same session; falls back to the most recent unlinked request of that session
   * that started before the message completed (e.g. aborted turns with no usage).
   * Returns the linked request, or null if none matched (yet).
   */
  linkMessage(projectId: string, sessionId: string, messageId: string, tokens: OcTokens | null, completedAt: number | null): LlmRequestStats | null {
    this.load(projectId)
    const links = this.links.get(projectId)!
    for (const [rid, mid] of links) if (mid === messageId) return this.all(projectId).find((r) => r.id === rid) ?? null
    const candidates = this.all(projectId).filter((r) => r.sessionId === sessionId && !links.has(r.id) && r.kind !== 'title')
    let match = tokens ? candidates.find((r) => tokensMatch(r, tokens)) : undefined
    if (!match && completedAt) {
      const before = candidates.filter((r) => r.startedAt <= completedAt + 1000 && (r.phase === 'aborted' || r.phase === 'error' || !r.usage))
      match = before[before.length - 1]
    }
    if (!match) return null
    this.link(projectId, match.id, messageId)
    return match
  }

  /** Stats for every linked assistant message of a session. */
  sessionMessageStats(projectId: string, sessionId: string): Record<string, { stats: MessageStats; requests: LlmRequestStats[] }> {
    this.load(projectId)
    const links = this.links.get(projectId)!
    const byMsg = new Map<string, LlmRequestStats[]>()
    for (const r of this.all(projectId)) {
      if (r.sessionId !== sessionId) continue
      const mid = links.get(r.id)
      if (!mid) continue
      if (!byMsg.has(mid)) byMsg.set(mid, [])
      byMsg.get(mid)!.push(r)
    }
    const out: Record<string, { stats: MessageStats; requests: LlmRequestStats[] }> = {}
    for (const [mid, reqs] of byMsg) out[mid] = { stats: messageStatsOf(reqs), requests: reqs }
    return out
  }

  /** Totals for a session (including its subagent sessions) and for the whole project. */
  totals(projectId: string, sessionId: string | null): { session: TotalsStats; project: TotalsStats } {
    let session = emptyTotals()
    let project = emptyTotals()
    for (const r of this.all(projectId)) {
      project = addToTotals(project, r)
      if (sessionId && (r.sessionId === sessionId || r.parentSessionId === sessionId)) session = addToTotals(session, r)
    }
    return { session, project }
  }
}
