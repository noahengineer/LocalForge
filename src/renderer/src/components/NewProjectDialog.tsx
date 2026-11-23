import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, CircleDashed, FileText, FolderOpen, GitBranch, Layers, Minus, Sparkles, X } from 'lucide-react'
import type { FolderInspection, TemplateId } from '@shared/api'
import { api, errMsg } from '../api'
import { selectProject, useStore } from '../store'
import { Button, cx, Meter, Modal, Spinner, Toggle } from './ui'

const ICONS: Record<string, string> = { empty: '∅', cpp: 'C++', 'react-ts': 'TSX', node: 'JS', python: 'Py', rust: 'Rs', electron: 'El' }

type Mode = 'new' | 'import'

const input = 'w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] outline-none focus:border-line-strong'

/** What LocalForge will do with git for this folder, shown under the checkpoints toggle. */
function checkpointHint(i: FolderInspection): string {
  switch (i.git.kind) {
    case 'none':
      return 'Not a git repository yet: LocalForge runs git init and commits the current files, then commits after each agent turn so you can undo.'
    case 'repo':
      return `Commits after each agent turn${i.git.branch ? ` on branch ${i.git.branch}` : ''}. Uncommitted changes are first committed as a snapshot, so Undo can always return to this exact state. Older history is never touched.`
    case 'parent':
      return `Creates a separate repository in this folder (the repository at ${i.git.parentRepo} is outside the mount and not visible to the sandbox).`
    case 'linked':
      return 'Unavailable: this is a git worktree or submodule whose repository data lives outside the folder.'
  }
}

function InspectionCard({ insp, loading }: { insp: FolderInspection | null; loading: boolean }) {
  if (loading && !insp) return <div className="flex items-center gap-2 text-[12.5px] text-muted"><Spinner className="h-3.5 w-3.5" /> Checking folder…</div>
  if (!insp) return null
  if (!insp.ok)
    return (
      <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-[12.5px] text-bad" data-testid="inspection-card" data-ok="false">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{insp.error}</span>
      </div>
    )
  const git =
    insp.git.kind === 'repo'
      ? `Git repository${insp.git.branch ? `, branch ${insp.git.branch}` : ''}${insp.git.head ? ` @ ${insp.git.head.slice(0, 7)}` : ''}`
      : insp.git.kind === 'none'
        ? 'Not a git repository'
        : insp.git.kind === 'parent'
          ? `Inside the git repository ${insp.git.parentRepo}`
          : 'Git worktree / submodule'
  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-bg px-3 py-2.5 text-[12.5px]" data-testid="inspection-card" data-ok="true">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="text-muted">Stack:</span>
        <span data-testid="inspection-stack">{insp.stack.kinds.length ? insp.stack.kinds.join(', ') : 'not detected (the agent will work it out)'}</span>
        <span className="ml-auto shrink-0 text-faint">{insp.fileCount >= 20000 ? '20,000+' : insp.fileCount.toLocaleString()} files</span>
      </div>
      <div className="flex items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span data-testid="inspection-git">{git}</span>
      </div>
      <div className="flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span data-testid="inspection-instructions">
          {insp.instructionsFile
            ? `Has ${insp.instructionsFile}: kept as is; LocalForge's rules are added inside the sandbox only`
            : 'No AGENTS.md: LocalForge adds one (rules, detected commands, sandbox notes)'}
        </span>
      </div>
      {insp.warnings.map((w) => (
        <div key={w} className="flex items-start gap-2 text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{w}</span>
        </div>
      ))}
    </div>
  )
}

export function NewProjectDialog() {
  const templates = useStore((s) => s.templates)
  const progress = useStore((s) => s.createProgress)
  const image = useStore((s) => s.image)
  const root = useStore((s) => s.settings?.projects.root ?? '~/AIProjects')
  const [mode, setMode] = useState<Mode>(useStore.getState().newProjectMode)
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<TemplateId>('cpp')
  const [desc, setDesc] = useState('')
  const [phase, setPhase] = useState<'form' | 'creating' | 'done' | 'error'>('form')
  const [error, setError] = useState<string | null>(null)
  // Import mode
  const [folder, setFolder] = useState('')
  const [insp, setInsp] = useState<FolderInspection | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [checkpoints, setCheckpoints] = useState(true)
  const [graph, setGraph] = useState(true)
  const nameTouched = useRef(false)

  // Inspect the folder as the path changes (debounced). Read-only: nothing is modified.
  useEffect(() => {
    if (mode !== 'import' || !folder.trim()) {
      setInsp(null)
      return
    }
    setInspecting(true)
    const h = setTimeout(() => {
      api
        .inspectFolder(folder)
        .then((r) => {
          setInsp(r)
          if (r.ok) {
            if (!nameTouched.current) setName(r.suggestedName)
            setCheckpoints(r.git.kind === 'none' || r.git.kind === 'repo')
          }
        })
        .catch((e) => setInsp({ ok: false, error: errMsg(e) } as FolderInspection))
        .finally(() => setInspecting(false))
    }, 350)
    return () => clearTimeout(h)
  }, [folder, mode])

  const close = () => {
    if (phase === 'creating') return
    useStore.setState({ showNewProject: false, createProgress: null })
  }

  const run = async () => {
    setPhase('creating')
    setError(null)
    useStore.setState({ createProgress: null })
    try {
      const r =
        mode === 'new'
          ? await api.createProject({ name: name.trim(), template, description: desc.trim() })
          : await api.importProject({ path: insp?.path ?? folder, name: name.trim(), description: desc.trim(), checkpoints, graph })
      setPhase('done')
      useStore.setState({ agentMode: desc.trim() ? 'plan' : 'build' })
      await selectProject(r.projectId, r.sessionId)
      useStore.setState({ showNewProject: false, createProgress: null })
    } catch (e) {
      setError(errMsg(e))
      setPhase('error')
    }
  }

  const browse = async () => {
    const p = await api.pickFolder().catch(() => null)
    if (p) setFolder(p)
  }

  const folderName = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '')
  const canSubmit = mode === 'new' ? !!name.trim() : !!(insp?.ok && name.trim() && !inspecting)

  return (
    <Modal
      title={mode === 'new' ? 'New project' : 'Open existing folder'}
      onClose={close}
      width="max-w-3xl"
      footer={
        phase === 'form' ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canSubmit} onClick={() => void run()} data-testid={mode === 'new' ? 'create-project-submit' : 'import-submit'}>
              {mode === 'new' ? 'Create project' : 'Import project'}
            </Button>
          </>
        ) : phase === 'error' ? (
          <>
            {progress?.projectId ? (
              <Button
                onClick={() => {
                  const pid = progress?.projectId
                  useStore.setState({ showNewProject: false, createProgress: null })
                  if (pid) void selectProject(pid)
                }}
              >
                Open project anyway
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setPhase('form')}>
              Back
            </Button>
          </>
        ) : null
      }
    >
      {phase === 'form' ? (
        <div className="space-y-5 p-5">
          <div className="flex overflow-hidden rounded-lg border border-line text-[13px]">
            <button
              className={cx('flex flex-1 items-center justify-center gap-1.5 px-3 py-2', mode === 'new' ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover')}
              onClick={() => setMode('new')}
              data-testid="mode-new"
            >
              <Layers className="h-3.5 w-3.5" /> New from template
            </button>
            <button
              className={cx('flex flex-1 items-center justify-center gap-1.5 border-l border-line px-3 py-2', mode === 'import' ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover')}
              onClick={() => setMode('import')}
              data-testid="mode-import"
            >
              <FolderOpen className="h-3.5 w-3.5" /> Open existing folder
            </button>
          </div>

          {mode === 'new' ? (
            <>
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-muted">Name</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && name.trim() && void run()}
                  placeholder="my-game"
                  data-testid="project-name"
                  className={input}
                />
                <div className="mt-1 font-mono text-[11.5px] text-faint">
                  {root}/{folderName || '…'}
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-muted">Template</label>
                <div className="grid grid-cols-2 gap-2">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      data-testid={`template-${t.id}`}
                      onClick={() => setTemplate(t.id)}
                      className={cx('flex items-start gap-3 rounded-xl border p-3 text-left transition-colors', template === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover/60')}
                    >
                      <span className="mt-0.5 w-9 shrink-0 rounded-md bg-raised py-1 text-center font-mono text-[11px] text-muted">{ICONS[t.id] ?? '·'}</span>
                      <span>
                        <span className="block text-[13.5px] font-medium">{t.name}</span>
                        <span className="block text-[12px] leading-snug text-muted">{t.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-muted">Folder</label>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="/path/to/your/project"
                    data-testid="import-path"
                    className={cx(input, 'font-mono text-[13px]')}
                  />
                  <Button onClick={() => void browse()} data-testid="import-browse">
                    <FolderOpen className="h-3.5 w-3.5" /> Browse…
                  </Button>
                </div>
                <div className="mt-1 text-[11.5px] text-faint">
                  Nothing is copied or moved: the agent works directly on this folder, from inside its sandbox. Removing the project from LocalForge never deletes it.
                </div>
              </div>
              <InspectionCard insp={insp} loading={inspecting} />
              {insp?.ok && (
                <>
                  <div>
                    <label className="mb-1.5 block text-[12.5px] font-medium text-muted">Name in LocalForge</label>
                    <input
                      value={name}
                      onChange={(e) => {
                        nameTouched.current = true
                        setName(e.target.value)
                      }}
                      data-testid="import-name"
                      className={input}
                    />
                  </div>
                  <div className="rounded-lg border border-line px-3 py-1">
                    <div data-testid="import-checkpoints" className={cx(insp.git.kind === 'linked' && 'pointer-events-none opacity-50')}>
                      <Toggle checked={checkpoints && insp.git.kind !== 'linked'} onChange={setCheckpoints} label="Git checkpoints (Undo)" hint={checkpointHint(insp)} />
                    </div>
                    <div className="border-t border-line" data-testid="import-graph">
                      <Toggle checked={graph} onChange={setGraph} label="Build a code knowledge graph (graphify)" hint="Writes graphify-out/ (kept out of git via .git/info/exclude). Helps the agent find its way around unfamiliar code." />
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {(mode === 'new' || insp?.ok) && (
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium text-muted">{mode === 'new' ? 'What do you want to build? (optional)' : 'What do you want to do with it? (optional)'}</label>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={3}
                data-testid="project-description"
                placeholder={mode === 'new' ? 'A terminal snake game with high scores…  The session will start in Plan mode with this.' : 'Add a settings screen and fix the crash on startup…  The session will start in Plan mode with this.'}
                className="w-full resize-none rounded-lg border border-line bg-bg px-3 py-2 text-[13.5px] outline-none focus:border-line-strong"
              />
            </div>
          )}
        </div>
      ) : (
        <div className="p-5" data-testid="create-progress">
          <div className="mb-3 text-[14px]">
            {phase === 'creating' ? (mode === 'new' ? 'Setting up' : 'Importing') : phase === 'done' ? 'Ready:' : 'Could not finish setting up'} <span className="font-medium">{name}</span>
          </div>
          <div className="space-y-1.5">
            {(progress?.steps ?? []).map((s) => (
              <div key={s.id} className="flex items-start gap-2.5 text-[13px]" data-testid={`step-${s.id}`} data-status={s.status}>
                <span className="mt-0.5 w-4 shrink-0">
                  {s.status === 'done' ? (
                    <Check className="h-4 w-4 text-ok" />
                  ) : s.status === 'running' ? (
                    <Spinner className="h-4 w-4 text-accent" />
                  ) : s.status === 'error' ? (
                    <X className="h-4 w-4 text-bad" />
                  ) : s.status === 'skipped' ? (
                    <Minus className="h-4 w-4 text-faint" />
                  ) : (
                    <CircleDashed className="h-4 w-4 text-faint" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cx(s.status === 'pending' && 'text-faint', s.status === 'error' && 'text-bad')}>{s.label}</div>
                  {s.detail && <div className="selectable mt-0.5 whitespace-pre-wrap break-words font-mono text-[11.5px] text-muted">{s.detail}</div>}
                  {s.id === 'image' && s.status === 'running' && image?.status === 'building' && (
                    <div className="mt-1.5">
                      <Meter value={image.step} max={Math.max(1, image.totalSteps)} />
                      <div className="mt-1 truncate font-mono text-[11px] text-faint">
                        step {image.step}/{image.totalSteps}: {image.stepText}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {error && <div className="selectable mt-4 whitespace-pre-wrap rounded-lg border border-bad/40 p-3 font-mono text-[12px] text-bad">{error}</div>}
        </div>
      )}
    </Modal>
  )
}
