import { useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Bot,
  Camera,
  Check,
  ChevronRight,
  CircleDashed,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  HelpCircle,
  Keyboard,
  ListChecks,
  MousePointerClick,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { DiffView } from '../DiffView'
import { Markdown } from './Markdown'
import { cx, Spinner } from '../ui'
import { fmtMs } from '../../format'

type Part = Record<string, any>

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v, null, 2))
const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const relPath = (p: string) => str(p).replace(/^\/workspace\//, '')
/** graphify's OpenCode plugin prefixes the first bash command with an `echo "[graphify] ..." &&` hint. */
export const cleanCommand = (c: unknown) => str(c).replace(/^echo "\[graphify\][^"]*" && /, '')

function iconFor(tool: string) {
  if (tool === 'bash') return SquareTerminal
  if (tool === 'edit' || tool === 'apply_patch') return FilePen
  if (tool === 'write') return FilePlus
  if (tool === 'read') return FileText
  if (tool === 'webfetch') return Globe
  if (tool === 'websearch') return Search
  if (tool === 'glob' || tool === 'grep' || tool === 'list') return Search
  if (tool === 'todowrite' || tool === 'todoread') return ListChecks
  if (tool === 'task') return Bot
  if (tool === 'question') return HelpCircle
  if (tool.endsWith('screenshot')) return Camera
  if (tool.startsWith('computer_type') || tool.startsWith('computer_key')) return Keyboard
  if (tool.startsWith('computer_')) return MousePointerClick
  if (tool.startsWith('playwright_')) return Globe
  return Wrench
}

function labelFor(tool: string): string {
  const names: Record<string, string> = {
    bash: 'Bash',
    edit: 'Edit',
    write: 'Write',
    read: 'Read',
    webfetch: 'Fetch',
    websearch: 'Web search',
    glob: 'Glob',
    grep: 'Grep',
    list: 'List',
    todowrite: 'Todos',
    task: 'Subagent',
    apply_patch: 'Patch',
    skill: 'Skill',
    question: 'Question',
  }
  if (names[tool]) return names[tool]
  if (tool.startsWith('computer_')) return 'Desktop · ' + tool.slice(9).replace(/_/g, ' ')
  if (tool.startsWith('playwright_')) return 'Browser · ' + tool.slice(11).replace(/^browser_/, '').replace(/_/g, ' ')
  return tool
}

/** One-line summary of the call shown in the collapsed header. */
function summaryOf(tool: string, input: Record<string, any>, title?: string): string {
  switch (tool) {
    case 'bash':
      return cleanCommand(input.command)
    case 'edit':
    case 'write':
    case 'read':
      return relPath(input.filePath ?? input.path ?? title ?? '')
    case 'webfetch':
      return str(input.url)
    case 'websearch':
      return str(input.query)
    case 'glob':
    case 'grep':
      return `${str(input.pattern)}${input.path ? ` in ${relPath(input.path)}` : ''}`
    case 'list':
      return relPath(input.path ?? '.')
    case 'task':
      return str(input.description)
    case 'question':
      return (Array.isArray(input.questions) ? input.questions : []).map((q: { question?: string }) => str(q.question)).join(' · ')
    default:
      if (tool.startsWith('computer_')) {
        if ('x' in input && 'y' in input) return `(${input.x}, ${input.y})${input.button ? ` ${input.button}` : ''}`
        return str(input.text ?? input.keys ?? input.command ?? input.seconds ?? title ?? '')
      }
      if (tool.startsWith('playwright_')) return str(input.url ?? input.element ?? input.text ?? input.key ?? title ?? '')
      return title ?? short(JSON.stringify(input))
  }
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cx('selectable max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-code p-2.5 font-mono text-[12px] leading-[1.5] text-fg/90', className)}>{children}</pre>
}

function Images({ state }: { state: Part }) {
  const atts = (state.attachments ?? []) as Part[]
  const imgs = atts.filter((a) => String(a.mime ?? '').startsWith('image/') && a.url)
  if (!imgs.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {imgs.map((a, i) => (
        <a key={i} href={a.url} target="_blank" rel="noreferrer" className="block">
          <img src={a.url} alt={a.filename ?? 'screenshot'} className="max-h-[360px] max-w-full rounded-md border border-line" />
        </a>
      ))}
    </div>
  )
}

function Body({ tool, state }: { tool: string; state: Part }) {
  const input = (state.input ?? {}) as Record<string, any>
  const md = (state.metadata ?? {}) as Record<string, any>
  const out = str(state.status === 'completed' ? state.output : (md.output ?? ''))
  const err = state.status === 'error' ? str(state.error) : ''
  switch (tool) {
    case 'bash':
      return (
        <div className="space-y-2">
          <Pre>
            <span className="text-faint">$ </span>
            {cleanCommand(input.command)}
          </Pre>
          {(out || state.status === 'running') && <Pre className="text-muted">{out || '…'}</Pre>}
          {typeof md.exit === 'number' && (
            <div className={cx('text-[11.5px]', md.exit === 0 ? 'text-muted' : 'text-bad')}>exit code {md.exit}</div>
          )}
          {err && <Pre className="text-bad">{err}</Pre>}
        </div>
      )
    case 'edit':
    case 'apply_patch': {
      const diff = str(md.diff ?? md.filediff?.patch ?? '')
      return (
        <div className="space-y-2">
          {diff ? <DiffView diff={diff} maxLines={300} /> : <Pre>{out}</Pre>}
          {err && <Pre className="text-bad">{err}</Pre>}
        </div>
      )
    }
    case 'write':
      return (
        <div className="space-y-2">
          <Pre>{str(input.content)}</Pre>
          {err && <Pre className="text-bad">{err}</Pre>}
        </div>
      )
    case 'todowrite': {
      const todos = (md.todos ?? input.todos ?? []) as Array<{ content: string; status: string }>
      return (
        <ul className="space-y-1 text-[13px]">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={cx('mt-0.5', t.status === 'completed' ? 'text-ok' : t.status === 'in_progress' ? 'text-accent' : 'text-faint')}>
                {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}
              </span>
              <span className={cx(t.status === 'completed' && 'text-muted line-through')}>{t.content}</span>
            </li>
          ))}
        </ul>
      )
    }
    case 'websearch':
    case 'webfetch':
      return (
        <div className="space-y-2">
          {out && (
            <div className="max-h-80 overflow-auto rounded-md bg-code p-3 text-[12.5px]">
              <Markdown text={out.length > 12000 ? out.slice(0, 12000) + '\n\n…' : out} />
            </div>
          )}
          <Images state={state} />
          {err && <Pre className="text-bad">{err}</Pre>}
        </div>
      )
    default:
      return (
        <div className="space-y-2">
          {Object.keys(input).length > 0 && !tool.endsWith('screenshot') && <Pre className="text-muted">{JSON.stringify(input, null, 2)}</Pre>}
          <Images state={state} />
          {out && <Pre>{out.length > 20000 ? out.slice(0, 20000) + '\n…' : out}</Pre>}
          {err && <Pre className="text-bad">{err}</Pre>}
        </div>
      )
  }
}

export function ToolCard({ part }: { part: Part }) {
  const tool = String(part.tool)
  const state = (part.state ?? {}) as Part
  const status = String(state.status ?? 'pending')
  const hasImage = ((state.attachments ?? []) as Part[]).some((a) => String(a.mime ?? '').startsWith('image/'))
  const [open, setOpen] = useState<boolean | null>(null)
  // Default: screenshots and errors open, running bash open (live output), the rest collapsed.
  const isOpen = open ?? (hasImage || status === 'error' || (status === 'running' && tool === 'bash'))
  const Icon = iconFor(tool)
  const input = (state.input ?? {}) as Record<string, any>
  const summary = summaryOf(tool, input, state.title)
  const dur = state.time?.end && state.time?.start ? state.time.end - state.time.start : null
  const md = (state.metadata ?? {}) as Record<string, any>
  const diffStat = tool === 'edit' && md.filediff ? `+${md.filediff.additions ?? 0} −${md.filediff.deletions ?? 0}` : null

  return (
    <div className={cx('my-1.5 overflow-hidden rounded-lg border bg-panel', status === 'error' ? 'border-bad/40' : 'border-line')} data-testid="tool-card" data-tool={tool}>
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover/60" onClick={() => setOpen(!isOpen)}>
        <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 text-faint transition-transform', isOpen && 'rotate-90')} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="shrink-0 text-[12.5px] font-medium">{labelFor(tool)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{summary}</span>
        {diffStat && <span className="shrink-0 font-mono text-[11.5px] text-muted">{diffStat}</span>}
        {dur !== null && <span className="shrink-0 text-[11px] text-faint">{fmtMs(dur)}</span>}
        <span className="shrink-0">
          {status === 'completed' ? (
            <Check className="h-3.5 w-3.5 text-ok" />
          ) : status === 'error' ? (
            <AlertTriangle className="h-3.5 w-3.5 text-bad" />
          ) : status === 'running' ? (
            <Spinner className="h-3.5 w-3.5 text-accent" />
          ) : (
            <CircleDashed className="h-3.5 w-3.5 text-faint" />
          )}
        </span>
      </button>
      {isOpen && (
        <div className="border-t border-line px-3 py-2.5">
          <Body tool={tool} state={state} />
        </div>
      )}
    </div>
  )
}
