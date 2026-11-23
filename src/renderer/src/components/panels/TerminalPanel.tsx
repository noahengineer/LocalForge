import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, errMsg, onBackendEvent } from '../../api'
import { useStore } from '../../store'
import { Button } from '../ui'

/** A shell inside the project's sandbox (OpenCode PTY, relayed by the main process). */
export function TerminalPanel() {
  const projectId = useStore((s) => s.projectId)
  const ready = useStore((s) => (s.projectId ? s.sandbox[s.projectId]?.opencodeReady : false))
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [gen, setGen] = useState(0)

  useEffect(() => {
    if (!projectId || !ready || !host.current) return
    const dark = document.documentElement.classList.contains('dark')
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
      fontSize: 12.5,
      cursorBlink: true,
      theme: dark
        ? { background: '#191816', foreground: '#ece9e3', cursor: '#e0874e', selectionBackground: '#e0874e44' }
        : { background: '#f1eee8', foreground: '#262420', cursor: '#c7652b', selectionBackground: '#c7652b33' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
    let ptyId: string | null = null
    let closed = false
    const off = onBackendEvent((ev) => {
      if (ev.type === 'pty-data' && ev.ptyId === ptyId) term.write(ev.data)
      if (ev.type === 'pty-exit' && ev.ptyId === ptyId) term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
    })
    api
      .ptyOpen(projectId, term.cols, term.rows)
      .then((id) => {
        if (closed) {
          void api.ptyClose(id)
          return
        }
        ptyId = id
        setError(null)
      })
      .catch((e) => setError(errMsg(e)))
    const sub = term.onData((d) => {
      if (ptyId) void api.ptyInput(ptyId, d)
    })
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (ptyId) void api.ptyResize(ptyId, term.cols, term.rows)
      } catch {
        /* hidden */
      }
    })
    ro.observe(host.current)
    return () => {
      closed = true
      ro.disconnect()
      sub.dispose()
      off()
      if (ptyId) void api.ptyClose(ptyId)
      term.dispose()
    }
  }, [projectId, ready, gen])

  return (
    <div className="flex h-full flex-col" data-testid="terminal-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12.5px] text-muted">
        <span>bash in the sandbox · /workspace</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setGen((g) => g + 1)}>
          New shell
        </Button>
      </div>
      {error && <div className="px-3 py-2 text-[12px] text-bad">{error}</div>}
      {!ready && <div className="px-3 py-2 text-[12.5px] text-muted">Start the sandbox to open a terminal.</div>}
      <div className="min-h-0 flex-1 bg-code p-2">
        <div ref={host} className="h-full w-full" />
      </div>
    </div>
  )
}
