import { Activity, FileDiff, FolderTree, Monitor, Network, SquareTerminal } from 'lucide-react'
import { useStore, type RightTab } from '../../store'
import { cx } from '../ui'
import { DesktopPanel } from './DesktopPanel'
import { FilesPanel } from './FilesPanel'
import { ChangesPanel } from './ChangesPanel'
import { TerminalPanel } from './TerminalPanel'
import { HardwarePanel } from './HardwarePanel'
import { GraphPanel } from './GraphPanel'

const TABS: Array<{ id: RightTab; label: string; icon: typeof Monitor }> = [
  { id: 'desktop', label: "Agent's Desktop", icon: Monitor },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'map', label: 'Map', icon: Network },
  { id: 'hardware', label: 'Hardware', icon: Activity },
]

export function RightPanel({ width }: { width: number }) {
  const tab = useStore((s) => s.rightTab)
  const projectId = useStore((s) => s.projectId)
  return (
    <aside className="flex h-full shrink-0 flex-col border-l border-line bg-bg" style={{ width }} data-testid="right-panel">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2 pt-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => useStore.setState({ rightTab: t.id })}
            className={cx(
              'flex items-center gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 px-2.5 pb-2 pt-1.5 text-[12.5px]',
              tab === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {!projectId && tab !== 'hardware' ? (
          <div className="p-4 text-[12.5px] text-muted">Open a project first.</div>
        ) : (
          <>
            {/* The desktop stays mounted so the VNC connection survives tab switches. */}
            <div className={cx('h-full', tab !== 'desktop' && 'hidden')}>{projectId && <DesktopPanel key={projectId} />}</div>
            {tab === 'files' && <FilesPanel key={projectId} />}
            {tab === 'changes' && <ChangesPanel key={projectId} />}
            {tab === 'terminal' && <TerminalPanel key={projectId} />}
            {tab === 'map' && projectId && <GraphPanel key={projectId} projectId={projectId} />}
            {tab === 'hardware' && <HardwarePanel />}
          </>
        )}
      </div>
    </aside>
  )
}
