import { useEffect, useState } from 'react'
import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { initStore, useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { ChatView } from './components/chat/ChatView'
import { RightPanel } from './components/panels/RightPanel'
import { NewProjectDialog } from './components/NewProjectDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Logo, Spinner, cx } from './components/ui'
import { ResizeHandle } from './components/ResizeHandle'

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[380px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          className={cx(
            'pointer-events-auto flex items-start gap-2 rounded-xl border bg-raised px-3.5 py-2.5 text-[13px] shadow-xl',
            t.level === 'error' ? 'border-bad/40' : t.level === 'success' ? 'border-ok/40' : 'border-line',
          )}
        >
          {t.level === 'error' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-bad" /> : t.level === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />}
          <span className="selectable min-w-0 break-words">{t.message}</span>
        </div>
      ))}
    </div>
  )
}

export function App() {
  const ready = useStore((s) => s.ready)
  const rightOpen = useStore((s) => s.rightOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const rightWidth = useStore((s) => s.rightWidth)
  const [vw, setVw] = useState(window.innerWidth)
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // The chat keeps at least CHAT_MIN px: when the window is too small for the saved widths, the right
  // panel gives way first (down to its minimum), then the sidebar. Saved widths are kept for later.
  const CHAT_MIN = 380
  const sideW = sidebarOpen ? Math.max(200, Math.min(sidebarWidth, vw - CHAT_MIN - (rightOpen ? 320 : 0))) : 0
  const rightW = rightOpen ? Math.max(320, Math.min(rightWidth, vw - sideW - CHAT_MIN)) : 0
  const showNew = useStore((s) => s.showNewProject)
  const showSettings = useStore((s) => s.showSettings)

  useEffect(() => {
    void initStore()
  }, [])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-muted">
        <Logo className="h-7 w-7 text-fg" />
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <>
          <Sidebar width={sideW} />
          <ResizeHandle
            side="left"
            width={sideW}
            min={200}
            max={Math.max(200, Math.min(480, vw - CHAT_MIN - (rightOpen ? 320 : 0)))}
            onResize={(w) => useStore.setState({ sidebarWidth: w })}
            onCollapse={() => useStore.setState({ sidebarOpen: false })}
            testId="sidebar-resize"
          />
        </>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <ChatView />
          </div>
          {rightOpen && (
            <>
              <ResizeHandle
                side="right"
                width={rightW}
                min={320}
                max={Math.max(320, vw - sideW - CHAT_MIN)}
                onResize={(w) => useStore.setState({ rightWidth: w })}
                onCollapse={() => useStore.setState({ rightOpen: false })}
                testId="right-resize"
              />
              <RightPanel width={rightW} />
            </>
          )}
        </div>
      </main>
      {showNew && <NewProjectDialog />}
      {showSettings && <SettingsDialog />}
      <Toasts />
    </div>
  )
}
