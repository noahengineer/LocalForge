import { useState } from 'react'
import { ChevronRight, FolderInput, FolderOpen, MessageSquare, MoreHorizontal, PanelLeftClose, Plus, Settings, Trash2 } from 'lucide-react'
import { api, errMsg } from '../api'
import { newSession, selectProject, selectSession, toast, useStore } from '../store'
import { cx, Dot, IconButton, Logo } from './ui'
import { timeAgo } from '../format'

const TEMPLATE_BADGE: Record<string, string> = {
  empty: '∅',
  cpp: 'C++',
  'react-ts': 'TSX',
  node: 'JS',
  python: 'Py',
  rust: 'Rs',
  electron: 'El',
  imported: 'Dir',
}

function ProjectMenu({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  if (!project) return null
  return (
    <div className="absolute right-1 top-7 z-30 w-56 overflow-hidden rounded-lg border border-line bg-raised py-1 text-[13px] shadow-xl" onMouseLeave={onClose}>
      <button className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-hover" onClick={() => void api.openProjectFolder(projectId).finally(onClose)}>
        <FolderOpen className="h-3.5 w-3.5" /> Open folder
      </button>
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-bad hover:bg-hover"
        onClick={async () => {
          onClose()
          const del = window.confirm(`Remove "${project.name}" from LocalForge?\n\nIts sandbox container is deleted. Your files at ${project.path} are kept.`)
          if (!del) return
          try {
            await api.removeProject(projectId, false)
            useStore.setState((s) => ({ projectId: s.projectId === projectId ? null : s.projectId, sessionId: s.projectId === projectId ? null : s.sessionId }))
          } catch (e) {
            toast('error', errMsg(e))
          }
        }}
      >
        <Trash2 className="h-3.5 w-3.5" /> Remove project
      </button>
    </div>
  )
}

export function Sidebar({ width: sidebarWidth }: { width: number }) {
  const projects = useStore((s) => s.projects)
  const projectId = useStore((s) => s.projectId)
  const sessionId = useStore((s) => s.sessionId)
  const sessions = useStore((s) => s.sessions)
  const status = useStore((s) => s.sessionStatus)
  const sandbox = useStore((s) => s.sandbox)
  const [menu, setMenu] = useState<string | null>(null)

  return (
    <aside className="flex h-full shrink-0 flex-col border-r border-line bg-panel" style={{ width: sidebarWidth }} data-testid="sidebar">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <Logo className="h-6 w-6 text-fg" />
        <span className="font-serif text-[18px] tracking-tight">LocalForge</span>
        <IconButton className="ml-auto" title="Hide projects" onClick={() => useStore.setState({ sidebarOpen: false })} data-testid="sidebar-close">
          <PanelLeftClose className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="px-3 pb-2">
        <button
          data-testid="new-project-button"
          onClick={() => useStore.setState({ showNewProject: true, newProjectMode: 'new' })}
          className="flex w-full items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-[13.5px] font-medium hover:bg-hover"
        >
          <Plus className="h-4 w-4 text-accent" /> New project
        </button>
        <button
          data-testid="open-folder-button"
          onClick={() => useStore.setState({ showNewProject: true, newProjectMode: 'import' })}
          className="mt-1.5 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-fg"
        >
          <FolderInput className="h-4 w-4" /> Open existing folder
        </button>
      </div>
      <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-faint">Projects</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projects.length === 0 && <div className="px-2 py-3 text-[12.5px] text-faint">No projects yet.</div>}
        {projects.map((p) => {
          const active = p.id === projectId
          const sb = sandbox[p.id]
          const list = (sessions[p.id] ?? []).filter((x) => !x.parentID)
          return (
            <div key={p.id} className="mb-0.5">
              <div
                className={cx('group relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5', active ? 'bg-hover' : 'hover:bg-hover/60')}
                onClick={() => !active && void selectProject(p.id)}
                data-testid="project-item"
                data-project-id={p.id}
              >
                <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 text-faint transition-transform', active && 'rotate-90')} />
                <span className="w-7 shrink-0 rounded bg-raised py-px text-center font-mono text-[10px] text-muted">{TEMPLATE_BADGE[p.template] ?? '·'}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{p.name}</span>
                <span title={`Sandbox: ${sb?.state ?? 'unknown'}`}>
                  <Dot color={sb?.state === 'running' ? 'ok' : sb?.state === 'error' ? 'bad' : sb?.state === 'creating' || sb?.state === 'starting' ? 'warn' : 'muted'} pulse={sb?.state === 'starting' || sb?.state === 'creating'} />
                </span>
                <IconButton
                  className="hidden h-5 w-5 group-hover:inline-flex"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenu(menu === p.id ? null : p.id)
                  }}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </IconButton>
                {menu === p.id && <ProjectMenu projectId={p.id} onClose={() => setMenu(null)} />}
              </div>
              {active && (
                <div className="ml-4 border-l border-line pl-2">
                  {list.map((s) => {
                    const st = status[s.id]
                    return (
                      <div
                        key={s.id}
                        onClick={() => void selectSession(s.id)}
                        data-testid="session-item"
                        className={cx(
                          'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12.5px]',
                          s.id === sessionId ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover/60 hover:text-fg',
                        )}
                        title={`${s.title}\nupdated ${timeAgo(s.time.updated)}`}
                      >
                        {st === 'busy' || st === 'retry' ? <Dot color="info" pulse /> : <MessageSquare className="h-3 w-3 shrink-0 opacity-60" />}
                        <span className="truncate">{s.title || 'Untitled'}</span>
                      </div>
                    )
                  })}
                  <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[12.5px] text-faint hover:bg-hover/60 hover:text-fg" onClick={() => void newSession()} data-testid="new-session">
                    <Plus className="h-3 w-3" /> New session
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="border-t border-line p-2">
        <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-fg" onClick={() => useStore.setState({ showSettings: true })} data-testid="settings-button">
          <Settings className="h-4 w-4" /> Settings
        </button>
      </div>
    </aside>
  )
}
