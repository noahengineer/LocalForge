import { useState } from 'react'
import { ChevronRight, Circle, CircleCheck, CircleDot, CircleSlash, ListChecks } from 'lucide-react'
import type { Todo } from '@shared/api'
import { useStore } from '../../store'
import { cx } from '../ui'

const EMPTY: Todo[] = []

function TaskIcon({ status }: { status: string }) {
  if (status === 'completed') return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-ok" />
  if (status === 'in_progress') return <CircleDot className="h-3.5 w-3.5 shrink-0 animate-pulse text-accent" />
  if (status === 'cancelled') return <CircleSlash className="h-3.5 w-3.5 shrink-0 text-faint" />
  return <Circle className="h-3.5 w-3.5 shrink-0 text-faint" />
}

/**
 * The agent's task list (OpenCode todos) for the open session, pinned at the top of the side panel
 * so it stays visible whichever tab is open. Updates live as the agent ticks tasks off.
 */
export function TasksBox() {
  const todos = useStore((s) => (s.sessionId ? s.todos[s.sessionId] : undefined)) ?? EMPTY
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('lf.tasksOpen') !== '0'
    } catch {
      return true
    }
  })
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const counted = todos.filter((t) => t.status !== 'cancelled').length
  const current = todos.find((t) => t.status === 'in_progress')
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem('lf.tasksOpen', open ? '0' : '1')
    } catch {
      /* not remembered */
    }
  }
  return (
    <div className="shrink-0 border-b border-line bg-panel" data-testid="tasks-box">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-hover/50" onClick={toggle} data-testid="tasks-toggle">
        <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="font-medium">Tasks</span>
        <span className="text-muted" data-testid="tasks-count">
          {done}/{counted}
        </span>
        <div className="mx-1 h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-ok transition-all" style={{ width: `${counted ? (done / counted) * 100 : 0}%` }} />
        </div>
        {!open && current && <span className="max-w-[45%] truncate text-[12px] text-muted">{current.content}</span>}
      </button>
      {open && (
        <ul className="max-h-[38vh] overflow-y-auto px-3 pb-2" data-testid="tasks-list">
          {todos.map((t, i) => (
            <li key={t.id ?? i} className="flex items-start gap-2 py-1 text-[12.5px] leading-snug" data-status={t.status}>
              <span className="mt-[2px]">
                <TaskIcon status={t.status} />
              </span>
              <span
                className={cx(
                  'min-w-0 flex-1',
                  t.status === 'completed' && 'text-muted line-through decoration-faint',
                  t.status === 'cancelled' && 'text-faint line-through',
                  t.status === 'in_progress' && 'font-medium text-fg',
                )}
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
