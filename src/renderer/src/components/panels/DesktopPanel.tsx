import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { Eye, MousePointer2, RefreshCw } from 'lucide-react'
import { useStore } from '../../store'
import { Button, cx, Dot } from '../ui'

/** The agent's own XFCE desktop, streamed from the sandbox through noVNC. */
export function DesktopPanel() {
  const projectId = useStore((s) => s.projectId)
  const port = useStore((s) => (s.projectId ? s.sandbox[s.projectId]?.novncPort : null))
  const running = useStore((s) => (s.projectId ? s.sandbox[s.projectId]?.state === 'running' : false))
  const host = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const [control, setControl] = useState(false)
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!port || !running || !host.current) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    setState('connecting')
    const rfb = new RFB(host.current, `ws://127.0.0.1:${port}/websockify`, { shared: true })
    rfb.scaleViewport = true
    rfb.resizeSession = false
    rfb.clipViewport = false
    rfb.qualityLevel = 7
    rfb.compressionLevel = 2
    rfb.viewOnly = !control
    rfb.background = 'transparent'
    let alive = true
    rfb.addEventListener('connect', () => !cancelled && setState('connected'))
    rfb.addEventListener('disconnect', () => {
      alive = false
      if (cancelled) return
      setState('disconnected')
      retry = setTimeout(() => setAttempt((a) => a + 1), 2500)
    })
    rfbRef.current = rfb
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      if (alive) {
        try {
          rfb.disconnect()
        } catch {
          /* already closed */
        }
      }
      rfbRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, running, projectId, attempt])

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !control
    if (control) rfbRef.current?.focus()
  }, [control])

  return (
    <div className="flex h-full flex-col" data-testid="desktop-panel" data-vnc-state={state}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Dot color={state === 'connected' ? 'ok' : state === 'connecting' ? 'warn' : 'muted'} pulse={state === 'connecting'} />
        <span className="text-[12.5px] text-muted">{state === 'connected' ? "Agent's desktop" : state === 'connecting' ? 'Connecting…' : running ? 'Disconnected, retrying…' : 'Sandbox not running'}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex overflow-hidden rounded-lg border border-line text-[12px]">
            <button
              className={cx('flex items-center gap-1 px-2 py-1', !control ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
              onClick={() => setControl(false)}
              data-testid="vnc-view-only"
            >
              <Eye className="h-3.5 w-3.5" /> View only
            </button>
            <button
              className={cx('flex items-center gap-1 px-2 py-1', control ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
              onClick={() => setControl(true)}
              data-testid="vnc-take-control"
            >
              <MousePointer2 className="h-3.5 w-3.5" /> Take control
            </button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setAttempt((a) => a + 1)} title="Reconnect">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className={cx('relative min-h-0 flex-1 bg-black/40', control && 'ring-2 ring-inset ring-accent/60')}>
        <div ref={host} className="vnc-host absolute inset-0" />
      </div>
    </div>
  )
}
