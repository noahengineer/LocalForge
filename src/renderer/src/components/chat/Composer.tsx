import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ArrowUp, FileText, ListTodo, Hammer, Square, X } from 'lucide-react'
import { api } from '../../api'
import { removeQueued, sendPrompt, stopSession, useStore, type QueuedPrompt } from '../../store'
import { cx } from '../ui'
import { EffortControl } from './EffortControl'
import { ModelControl } from './ModelControl'

const NO_QUEUE: QueuedPrompt[] = []

interface Mention {
  start: number
  query: string
}

export function Composer({ busy, disabled, placeholder }: { busy: boolean; disabled?: boolean; placeholder?: string }) {
  const projectId = useStore((s) => s.projectId)
  const sessionId = useStore((s) => s.sessionId)
  const mode = useStore((s) => s.agentMode)
  const queue = useStore((s) => (s.sessionId ? s.queue[s.sessionId] : undefined)) ?? NO_QUEUE
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Array<{ path: string }>>([])
  const [images, setImages] = useState<QueuedPrompt['images']>([])
  const [mention, setMention] = useState<Mention | null>(null)
  const [results, setResults] = useState<string[]>([])
  const [sel, setSel] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)

  // Auto-size the textarea.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [text])

  useEffect(() => {
    ta.current?.focus()
  }, [sessionId])

  // @file search (debounced) through OpenCode's file finder inside the sandbox.
  useEffect(() => {
    if (!mention || !projectId) {
      setResults([])
      return
    }
    const h = setTimeout(() => {
      api
        .findFiles(projectId, mention.query)
        .then((r) => {
          setResults(r.slice(0, 12))
          setSel(0)
        })
        .catch(() => setResults([]))
    }, 120)
    return () => clearTimeout(h)
  }, [mention, projectId])

  const toggleMode = () => useStore.setState({ agentMode: mode === 'build' ? 'plan' : 'build' })

  const updateMention = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([\w./-]*)$/.exec(before)
    setMention(m ? { start: caret - m[2].length - 1, query: m[2] } : null)
  }

  const pick = (path: string) => {
    if (!mention) return
    const caret = ta.current?.selectionStart ?? text.length
    const next = text.slice(0, mention.start) + '@' + path + ' ' + text.slice(caret)
    setText(next)
    setFiles((f) => (f.some((x) => x.path === path) ? f : [...f, { path }]))
    setMention(null)
    requestAnimationFrame(() => {
      const pos = mention.start + path.length + 2
      ta.current?.setSelectionRange(pos, pos)
      ta.current?.focus()
    })
  }

  const submit = () => {
    const t = text.trim()
    if (!t && images.length === 0) return
    // Only keep mentioned files that are still referenced in the text.
    const used = files.filter((f) => text.includes('@' + f.path))
    void sendPrompt({ text: t, agent: mode, files: used, images })
    setText('')
    setFiles([])
    setImages([])
    setMention(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && results.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % results.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + results.length) % results.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(results[sel])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      toggleMode()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault()
      void stopSession()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'))
    if (items.length === 0) return
    e.preventDefault()
    for (const it of items) {
      const f = it.getAsFile()
      if (!f) continue
      const r = new FileReader()
      r.onload = () => setImages((imgs) => [...imgs, { mime: f.type, dataUrl: String(r.result), filename: f.name || 'pasted-image.png' }])
      r.readAsDataURL(f)
    }
  }

  return (
    <div className="relative">
      {queue.length > 0 && sessionId && (
        <div className="mb-2 space-y-1" data-testid="queue">
          {queue.map((q) => (
            <div key={q.id} className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-muted">
              <span className="shrink-0 rounded bg-raised px-1.5 text-[11px] uppercase tracking-wide">queued</span>
              <span className="min-w-0 flex-1 truncate">{q.text || '(image)'}</span>
              <button className="text-faint hover:text-fg" onClick={() => removeQueued(sessionId, q.id)} title="Remove from queue">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {mention && results.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-[min(520px,100%)] overflow-hidden rounded-lg border border-line bg-raised shadow-xl" data-testid="mention-popup">
          {results.map((r, i) => (
            <button
              key={r}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(r)
              }}
              className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12.5px]', i === sel ? 'bg-hover text-fg' : 'text-muted')}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{r}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cx(
          'rounded-2xl border bg-panel shadow-sm transition-colors focus-within:border-line-strong',
          mode === 'plan' ? 'border-plan/50' : 'border-line',
          disabled && 'opacity-60',
        )}
      >
        {(images.length > 0 || files.length > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img, i) => (
              <div key={i} className="group relative">
                <img src={img.dataUrl} alt="" className="h-16 w-16 rounded-md border border-line object-cover" />
                <button
                  className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-fg text-bg group-hover:flex"
                  onClick={() => setImages((x) => x.filter((_, j) => j !== i))}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {files.map((f) => (
              <span key={f.path} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-raised px-2 font-mono text-[11.5px] text-muted">
                <FileText className="h-3 w-3" />@{f.path}
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          disabled={disabled}
          data-testid="composer-input"
          onChange={(e) => {
            setText(e.target.value)
            updateMention(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={(e) => updateMention(text, e.currentTarget.selectionStart)}
          rows={1}
          placeholder={placeholder ?? (busy ? 'Queue a follow-up…' : 'Ask the agent to build, fix or explain something… (@ to mention files)')}
          className="block w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[14px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="@container flex items-center gap-2 px-2.5 pb-2.5">
          <button
            onClick={toggleMode}
            data-testid="mode-toggle"
            data-mode={mode}
            title="Switch Plan / Build (Tab)"
            className={cx(
              'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors',
              mode === 'plan' ? 'border-plan/40 bg-plan/10 text-plan' : 'border-line text-muted hover:text-fg',
            )}
          >
            {mode === 'plan' ? <ListTodo className="h-3.5 w-3.5" /> : <Hammer className="h-3.5 w-3.5" />}
            {mode === 'plan' ? 'Plan' : 'Build'}
          </button>
          <ModelControl />
          <EffortControl />
          <span className="hidden min-w-0 truncate text-[11.5px] text-faint @[620px]:inline" title={mode === 'plan' ? 'Read-only: the agent plans and asks before changing files' : 'Tab to switch to Plan mode'}>{mode === 'plan' ? 'Read-only: the agent plans and asks before changing files' : 'Tab to switch to Plan mode'}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {busy && (
              <button
                onClick={() => void stopSession()}
                data-testid="stop-button"
                title="Stop (Esc)"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line-strong text-fg hover:bg-hover"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            )}
            <button
              onClick={submit}
              disabled={disabled || (!text.trim() && images.length === 0)}
              data-testid="send-button"
              title={busy ? 'Queue message' : 'Send (Enter)'}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity hover:brightness-110 disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
