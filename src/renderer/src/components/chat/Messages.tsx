import { memo, useMemo, useState } from 'react'
import { FileText, Layers, Pencil, RotateCcw, RotateCw } from 'lucide-react'
import { api, errMsg } from '../../api'
import { toast } from '../../store'
import type { OcMessage } from '@shared/api'
import type { LlmRequestStats, MessageStats } from '@shared/stats'
import type { Settings } from '@shared/settings'
import { messageStatsOf } from '@shared/statsMath'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './Thinking'
import { ToolCard } from './ToolCard'
import { StatsFooter } from './StatsFooter'

type MsgStats = Record<string, { stats: MessageStats; requests: LlmRequestStats[] }>

export interface RerunCtx {
  projectId: string
  sessionId: string
  /** Number of your messages after this one (they get removed). */
  laterCount: number
}

function UserMessage({ msg, rerun }: { msg: OcMessage; rerun?: RerunCtx }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const parts = msg.parts
  const compaction = parts.find((p) => p.type === 'compaction')
  if (compaction) {
    return (
      <div className="my-5 flex items-center gap-3 text-[12px] text-muted" data-testid="compaction-marker">
        <div className="h-px flex-1 bg-line" />
        <Layers className="h-3.5 w-3.5" />
        {compaction.auto ? 'Context was full: OpenCode compacted the conversation' : 'Conversation compacted'}
        <div className="h-px flex-1 bg-line" />
      </div>
    )
  }
  const texts = parts.filter((p) => p.type === 'text' && !p.synthetic && !p.ignored)
  const files = parts.filter((p) => p.type === 'file')
  if (texts.length === 0 && files.length === 0) return null
  const original = texts.map((t) => String(t.text ?? '')).join('\n')
  const go = async (newText: string | null) => {
    if (!rerun) return
    const later = rerun.laterCount
    const what = newText === null ? 'Run this message again' : 'Send the edited message'
    if (!window.confirm(`${what}?\n\nThe answer to it${later ? ` and the ${later} message${later > 1 ? 's' : ''} after it` : ''} will be removed, and files the agent changed since then are put back.`)) return
    setBusy(true)
    try {
      await api.rerunMessage(rerun.projectId, rerun.sessionId, msg.info.id, newText)
      setEditing(false)
    } catch (e) {
      toast('error', `Could not ${newText === null ? 'retry' : 'edit'}: ${errMsg(e)}`)
    } finally {
      setBusy(false)
    }
  }
  if (editing) {
    return (
      <div className="my-4 flex justify-end" data-testid="user-message-editor">
        <div className="w-full rounded-2xl border border-accent bg-raised px-3 py-2.5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
              if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                e.preventDefault()
                void go(draft)
              }
            }}
            rows={Math.min(12, Math.max(2, draft.split('\n').length))}
            className="w-full resize-y bg-transparent text-[14px] leading-relaxed outline-none"
            data-testid="edit-input"
          />
          {files.length > 0 && <div className="mt-1 text-[11.5px] text-faint">Attachments are sent again unchanged.</div>}
          <div className="mt-2 flex justify-end gap-2">
            <button className="rounded-lg px-3 py-1 text-[12.5px] text-muted hover:bg-hover" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              disabled={busy || !draft.trim()}
              className="rounded-lg bg-accent px-3 py-1 text-[12.5px] font-medium text-white disabled:opacity-50"
              onClick={() => void go(draft)}
              data-testid="edit-send"
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="group my-4 flex flex-col items-end" data-testid="user-message">
      <div className="max-w-full rounded-2xl bg-raised px-4 py-2.5">
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {files.map((f) =>
              String(f.mime).startsWith('image/') ? (
                <img key={f.id} src={f.url} alt={f.filename ?? 'image'} className="max-h-40 rounded-md border border-line" />
              ) : (
                <span key={f.id} className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-0.5 font-mono text-[12px] text-muted">
                  <FileText className="h-3 w-3" />
                  {f.filename ?? f.url}
                </span>
              ),
            )}
          </div>
        )}
        {texts.map((t) => (
          <div key={t.id} className="selectable whitespace-pre-wrap text-[14px] leading-relaxed">
            {t.text}
          </div>
        ))}
      </div>
      {rerun && (
        <div className="mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            title="Edit and resend"
            disabled={busy}
            className="rounded-md p-1.5 text-faint hover:bg-hover hover:text-fg"
            onClick={() => {
              setDraft(original)
              setEditing(true)
            }}
            data-testid="edit-message"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button title="Run again" disabled={busy} className="rounded-md p-1.5 text-faint hover:bg-hover hover:text-fg" onClick={() => void go(null)} data-testid="retry-message">
            <RotateCw className={busy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          </button>
        </div>
      )}
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({
  msg,
  stats,
  liveReasoningTokens,
  settings,
  showFooter,
}: {
  msg: OcMessage
  stats?: { stats: MessageStats; requests: LlmRequestStats[] }
  liveReasoningTokens: number | null
  settings: Settings
  showFooter: boolean
}) {
  const info = msg.info
  const completed = !!info.time?.completed
  const toggles = settings.ui.stats
  const err = info.error as { name?: string; data?: { message?: string }; message?: string } | undefined
  const textParts = msg.parts.filter((p) => p.type === 'text')
  const lastTextId = textParts[textParts.length - 1]?.id
  return (
    <div className={info.summary ? 'my-2 rounded-lg border border-line bg-panel px-3 py-2' : ''} data-testid="assistant-message" data-message-id={info.id}>
      {info.summary && <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-faint">Conversation summary</div>}
      {msg.parts.map((p) => {
        switch (p.type) {
          case 'reasoning': {
            if (!toggles.thinking) return null
            const active = !p.time?.end && !completed
            if (!p.text && !active) return null
            const tokens = stats?.stats.reasoningTokens ?? liveReasoningTokens
            return <ThinkingBlock key={p.id} text={String(p.text ?? '')} startedAt={p.time?.start} endedAt={p.time?.end} tokens={tokens ?? null} active={active} />
          }
          case 'text':
            if (!p.text) return null
            return (
              <div key={p.id} className="my-1.5 text-[14px]" data-testid="assistant-text" data-streaming={!p.time?.end && !completed && p.id === lastTextId ? 'true' : 'false'}>
                <Markdown text={String(p.text)} />
              </div>
            )
          case 'tool':
            return <ToolCard key={p.id} part={p} />
          case 'retry':
            return (
              <div key={p.id} className="my-1 text-[12px] text-warn">
                Retrying (attempt {p.attempt}): {p.error?.data?.message ?? p.error?.message ?? 'provider error'}
              </div>
            )
          default:
            return null
        }
      })}
      {err && (
        <div className={`my-1.5 rounded-md border px-3 py-2 text-[12.5px] ${/Aborted/i.test(err.name ?? '') ? 'border-line text-muted' : 'border-bad/40 text-bad'}`}>
          {/Aborted/i.test(err.name ?? '') ? 'Stopped.' : `${err.name ?? 'Error'}: ${err.data?.message ?? err.message ?? ''}`}
        </div>
      )}
      {showFooter && toggles.messageFooter && stats && completed && <StatsFooter stats={stats.stats} requests={stats.requests} mode={settings.ui.statsMode} />}
    </div>
  )
})

/** A user message and the assistant steps that answered it. */
interface Turn {
  user: OcMessage | null
  assistants: OcMessage[]
}

function groupTurns(msgs: OcMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of msgs) {
    if (m.info.role === 'user') turns.push({ user: m, assistants: [] })
    else {
      if (turns.length === 0) turns.push({ user: null, assistants: [] })
      turns[turns.length - 1].assistants.push(m)
    }
  }
  return turns
}

export function MessageList({
  messages,
  msgStats,
  settings,
  liveReasoning,
  revertMessageId,
  projectId,
  sessionId,
}: {
  projectId: string
  sessionId: string | null
  messages: OcMessage[]
  msgStats: MsgStats
  settings: Settings
  liveReasoning: number | null
  revertMessageId: string | null
}) {
  const visible = useMemo(() => (revertMessageId ? messages.filter((m) => m.info.id < revertMessageId) : messages), [messages, revertMessageId])
  const turns = useMemo(() => groupTurns(visible), [visible])
  const detailed = settings.ui.statsMode === 'detailed'
  const lastAssistant = visible.filter((m) => m.info.role === 'assistant').pop()
  return (
    <div>
      {turns.map((t, ti) => {
        const turnStats = !detailed ? t.assistants.map((a) => msgStats[a.info.id]).filter(Boolean) : []
        const allDone = t.assistants.length > 0 && t.assistants.every((a) => a.info.time?.completed)
        return (
          <div key={t.user?.info.id ?? `t${ti}`}>
            {t.user && (
              <UserMessage
                msg={t.user}
                rerun={sessionId ? { projectId, sessionId, laterCount: turns.slice(ti + 1).filter((x) => x.user).length } : undefined}
              />
            )}
            {t.assistants.map((a) => (
              <AssistantMessage
                key={a.info.id}
                msg={a}
                stats={msgStats[a.info.id]}
                liveReasoningTokens={a.info.id === lastAssistant?.info.id && !a.info.time?.completed ? liveReasoning : null}
                settings={settings}
                showFooter={detailed}
              />
            ))}
            {!detailed && allDone && turnStats.length > 0 && settings.ui.stats.messageFooter && (
              <StatsFooter stats={messageStatsOf(turnStats.flatMap((s) => s.requests))} requests={turnStats.flatMap((s) => s.requests)} mode="compact" />
            )}
          </div>
        )
      })}
      {revertMessageId && (
        <div className="my-4 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px] text-muted">
          <RotateCcw className="h-3.5 w-3.5" />
          Undone to a checkpoint. Later messages are hidden and will be removed when you send a new message.
        </div>
      )}
    </div>
  )
}
