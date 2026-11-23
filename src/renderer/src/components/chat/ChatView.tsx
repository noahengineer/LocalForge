import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Box, RefreshCw } from 'lucide-react'
import { selectProject, useStore } from '../../store'
import { MessageList } from './Messages'
import { LiveStatus } from './LiveStatus'
import { Composer } from './Composer'
import { PermissionCard, QuestionCard } from './Prompts'
import { Button, Logo, Meter, Spinner } from '../ui'

function SandboxBanner({ projectId }: { projectId: string }) {
  const sb = useStore((s) => s.sandbox[projectId])
  const image = useStore((s) => s.image)
  const err = useStore((s) => s.connectError[projectId])
  if (err) {
    return (
      <div className="mx-auto mt-16 max-w-xl rounded-xl border border-bad/40 bg-panel p-5">
        <div className="mb-2 flex items-center gap-2 font-medium text-bad">
          <AlertTriangle className="h-4 w-4" /> Sandbox could not start
        </div>
        <pre className="selectable mb-3 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[12px] text-muted">{err}</pre>
        <Button onClick={() => void selectProject(projectId)}>
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    )
  }
  const building = image?.status === 'building'
  return (
    <div className="mx-auto mt-24 flex max-w-md flex-col items-center gap-3 text-center text-muted" data-testid="sandbox-starting">
      <Spinner className="h-5 w-5 text-accent" />
      <div className="text-[14px] text-fg">
        {building ? 'Building the sandbox image (first run only)…' : sb?.state === 'creating' ? 'Creating the sandbox…' : 'Starting the sandbox…'}
      </div>
      {building && image && (
        <div className="w-full">
          <Meter value={image.step} max={Math.max(1, image.totalSteps)} />
          <div className="mt-1.5 truncate font-mono text-[11.5px] text-faint">
            step {image.step}/{image.totalSteps}: {image.stepText}
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState({ name, imported }: { name: string; imported: boolean }) {
  return (
    <div className="mx-auto mt-[14vh] flex max-w-lg flex-col items-center text-center">
      <Logo className="mb-4 h-11 w-11 text-fg" />
      <div className="mb-1.5 font-serif text-[26px] text-fg">{imported ? `What should we work on in ${name}?` : `What should we build in ${name}?`}</div>
      <div className="text-[13.5px] text-muted">
        The agent works inside this project's sandbox: it can run commands, build, test, browse the web and use its own desktop. Press <kbd className="rounded border border-line px-1">Tab</kbd> for Plan mode.
      </div>
    </div>
  )
}

export function ChatView() {
  const projectId = useStore((s) => s.projectId)
  const sessionId = useStore((s) => s.sessionId)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectId))
  const messages = useStore((s) => (s.sessionId ? s.messages[s.sessionId] : undefined))
  const msgStats = useStore((s) => s.msgStats)
  const status = useStore((s) => (s.sessionId ? s.sessionStatus[s.sessionId] : undefined))
  const live = useStore((s) => s.live)
  const permissions = useStore((s) => s.permissions)
  const questions = useStore((s) => s.questions)
  const session = useStore((s) => (s.projectId && s.sessionId ? s.sessions[s.projectId]?.find((x) => x.id === s.sessionId) : undefined))
  const ready = useStore((s) => (s.projectId ? s.sandbox[s.projectId]?.opencodeReady : false))
  const busy = status === 'busy' || status === 'retry'

  const scroller = useRef<HTMLDivElement>(null)
  // Follow the conversation while it streams, unless the user has scrolled up to read.
  const stick = useRef(true)
  const lastTop = useRef(0)
  // True while the user holds the mouse on the scroll area (dragging the scrollbar).
  const pointerDown = useRef(false)
  const [following, setFollowing] = useState(true)
  const setStick = (v: boolean) => {
    stick.current = v
    setFollowing(v)
  }
  const [busySince, setBusySince] = useState<number | null>(null)
  useEffect(() => setBusySince(busy ? Date.now() : null), [busy])

  // Active LLM request for this session (or one of its subagent sessions).
  const req = useMemo(() => {
    const rs = Object.values(live).filter((r) => r.sessionId === sessionId || r.parentSessionId === sessionId)
    rs.sort((a, b) => b.startedAt - a.startedAt)
    return rs[0] ?? null
  }, [live, sessionId])

  const runningTool = useMemo(() => {
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0 && i >= messages.length - 3; i--) {
      const t = messages[i].parts.find((p) => p.type === 'tool' && p.state?.status === 'running')
      if (t) return String(t.tool)
    }
    return null
  }, [messages])

  // Switching sessions jumps to the newest message.
  useEffect(() => setStick(true), [sessionId])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
    }
  })

  if (!projectId || !project || !settings) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted">
        <Box className="mb-3 h-8 w-8" />
        <div>Create a project to get started.</div>
      </div>
    )
  }

  const myPermissions = permissions.filter((p) => p.sessionID === sessionId || !sessionId)
  const myQuestions = questions.filter((q) => q.sessionID === sessionId || !sessionId)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onWheel={(e) => {
          if (e.deltaY < 0 && stick.current) setStick(false)
        }}
        onPointerDown={() => (pointerDown.current = true)}
        onPointerUp={() => (pointerDown.current = false)}
        onPointerCancel={() => (pointerDown.current = false)}
        onKeyDown={(e) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) && stick.current) setStick(false)
        }}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          // Any upward movement by the user (scrollbar drag, touchpad) stops following;
          // reaching the very bottom again resumes it.
          // Only the user scrolling up stops following: the wheel/keys above, or dragging the scrollbar
          // up here. (A still-running smooth-scroll animation must not count, or it races the auto-follow.)
          if (pointerDown.current && el.scrollTop < lastTop.current - 1 && stick.current) setStick(false)
          else if (atBottom && !stick.current) setStick(true)
          lastTop.current = el.scrollTop
        }}
        data-testid="chat-scroll"
      >
        <div className="mx-auto max-w-[820px] px-6 pb-6 pt-4">
          {!ready && <SandboxBanner projectId={projectId} />}
          {ready && messages && messages.length === 0 && <EmptyState name={project.name} imported={project.template === 'imported'} />}
          {ready && messages && (
            <MessageList
              projectId={projectId}
              sessionId={sessionId}
              messages={messages}
              msgStats={msgStats}
              settings={settings}
              liveReasoning={req?.reasoningTokens ?? null}
              revertMessageId={session?.revert?.messageID ?? null}
            />
          )}
          {busy && <LiveStatus req={req} toggles={settings.ui.stats} busySince={busySince} runningTool={runningTool} />}
        </div>
      </div>
      <div className="relative mx-auto w-full max-w-[820px] px-6 pb-5">
        {!following && (
          <button
            data-testid="jump-to-latest"
            onClick={() => {
              setStick(true)
              const el = scroller.current
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            }}
            className="absolute -top-11 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-raised px-3 py-1 text-[12px] text-muted shadow-lg hover:text-fg"
          >
            ↓ Jump to latest
          </button>
        )}
        {myPermissions.map((p) => (
          <PermissionCard key={p.id} projectId={projectId} req={p} />
        ))}
        {myQuestions.map((q) => (
          <QuestionCard key={q.id} projectId={projectId} req={q} />
        ))}
        <Composer busy={busy} disabled={!ready || !sessionId} />
      </div>
    </div>
  )
}
