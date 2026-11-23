import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cx, useTick } from '../ui'
import { fmtInt, fmtMs } from '../../format'

/**
 * Reasoning block: expanded (and auto-scrolling) while the model thinks, auto-collapses once the
 * answer starts. The header shows the thinking time and token count.
 */
export function ThinkingBlock({ text, startedAt, endedAt, tokens, active }: { text: string; startedAt?: number; endedAt?: number; tokens: number | null; active: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? active
  const now = useTick(250, active)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Follow the reasoning while it streams, unless the user has scrolled up to read it; scrolling
  // back to the very bottom follows again (same behaviour as the chat itself).
  const stick = useRef(true)
  const lastTop = useRef(0)
  const pointerDown = useRef(false)
  useEffect(() => {
    if (!open) stick.current = true
  }, [open])
  useEffect(() => {
    const el = bodyRef.current
    if (active && open && el && stick.current) {
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
    }
  }, [text, active, open])
  const dur = startedAt ? (endedAt ?? now) - startedAt : null
  return (
    <div className="my-1.5" data-testid="thinking-block" data-active={active ? 'true' : 'false'}>
      <button className="flex items-center gap-1.5 rounded-md py-0.5 text-[12.5px] text-muted hover:text-fg" onClick={() => setUserOpen(!open)}>
        <ChevronRight className={cx('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        <Brain className="h-3.5 w-3.5" />
        <span className={cx(active && 'lf-shimmer-text font-medium')}>{active ? 'Thinking…' : 'Thought'}</span>
        <span className="text-faint" data-testid="thinking-meta">
          {dur !== null && `for ${fmtMs(dur)}`}
          {tokens !== null && tokens > 0 && ` · ${fmtInt(tokens)} tokens`}
        </span>
      </button>
      {open && (
        <div
          ref={bodyRef}
          data-testid="thinking-body"
          onWheel={(e) => {
            if (e.deltaY < 0) stick.current = false
          }}
          onPointerDown={() => (pointerDown.current = true)}
          onPointerUp={() => (pointerDown.current = false)}
          onPointerCancel={() => (pointerDown.current = false)}
          onKeyDown={(e) => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) stick.current = false
          }}
          onScroll={(e) => {
            const el = e.currentTarget
            // Only the user scrolling up stops following (wheel/keys, or dragging the scrollbar up).
            if (pointerDown.current && el.scrollTop < lastTop.current - 1) stick.current = false
            else if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) stick.current = true
            lastTop.current = el.scrollTop
          }}
          className="selectable ml-[7px] mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3.5 text-[13px] leading-relaxed text-muted"
        >
          {text || '…'}
        </div>
      )}
    </div>
  )
}
