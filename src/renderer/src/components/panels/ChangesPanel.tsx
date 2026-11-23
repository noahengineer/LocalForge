import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitCommitHorizontal, RefreshCw, RotateCcw } from 'lucide-react'
import type { ChangesInfo } from '@shared/api'
import { api, errMsg } from '../../api'
import { refreshCheckpoints, selectSession, toast, useStore } from '../../store'
import { DiffFileView, parseUnifiedDiff } from '../DiffView'
import { Button, cx, IconButton, Spinner } from '../ui'
import { timeAgo } from '../../format'

const STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' }

export function ChangesPanel() {
  const projectId = useStore((s) => s.projectId)
  const sessionId = useStore((s) => s.sessionId)
  const checkpoints = useStore((s) => (s.projectId ? (s.checkpoints[s.projectId] ?? null) : null))
  const busy = useStore((s) => (s.sessionId ? s.sessionStatus[s.sessionId] === 'busy' : false))
  const [changes, setChanges] = useState<ChangesInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [undoing, setUndoing] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      setChanges(await api.getChanges(projectId))
      await refreshCheckpoints(projectId)
    } catch (e) {
      toast('error', `Changes: ${errMsg(e)}`)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh, busy])

  const files = useMemo(() => (changes ? parseUnifiedDiff(changes.diff) : []), [changes])

  const undo = async (commit: string, subject: string) => {
    if (!projectId) return
    if (!window.confirm(`Undo to checkpoint "${subject}"?\n\nFiles are reset to that checkpoint and later conversation turns are hidden. Uncommitted changes are discarded.`)) return
    setUndoing(commit)
    try {
      await api.undoToCheckpoint(projectId, sessionId, commit)
      if (sessionId) await selectSession(sessionId)
      await refresh()
      toast('success', 'Restored checkpoint')
    } catch (e) {
      toast('error', `Undo failed: ${errMsg(e)}`)
    } finally {
      setUndoing(null)
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="changes-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12.5px] text-muted">
        <span className="truncate">Changes since {changes?.baseSubject ? `“${changes.baseSubject}”` : 'last checkpoint'}</span>
        <IconButton className="ml-auto" onClick={() => void refresh()} title="Refresh">
          {loading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {changes && changes.files.length === 0 && <div className="mb-3 text-[12.5px] text-faint">No uncommitted changes. The agent's work is saved in checkpoints below.</div>}
        {changes && changes.files.length > 0 && (
          <div className="mb-3 space-y-0.5">
            {changes.files.map((f) => (
              <div key={f.path} className="flex items-center gap-2 font-mono text-[12px]">
                <span className={cx('w-16 shrink-0 text-[10.5px] uppercase', f.status === 'D' ? 'text-bad' : f.status === 'A' ? 'text-ok' : 'text-warn')}>{STATUS[f.status] ?? f.status}</span>
                <span className="truncate">{f.path}</span>
                <span className="ml-auto shrink-0">
                  <span className="text-ok">+{f.additions}</span> <span className="text-bad">−{f.deletions}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-3">
          {files.map((f, i) => (
            <DiffFileView key={i} file={f} maxLines={250} />
          ))}
        </div>
        <div className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-wider text-faint">Checkpoints</div>
        {checkpoints === null && <Spinner />}
        {checkpoints?.length === 0 && <div className="text-[12.5px] text-faint">No checkpoints yet. One is saved after every agent turn.</div>}
        <div className="space-y-1">
          {checkpoints?.map((c, i) => (
            <div key={c.commit} className="group flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5" data-testid="checkpoint-item">
              <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px]">{c.subject}</div>
                <div className="text-[11px] text-faint">
                  {c.shortCommit} · {timeAgo(c.time)}
                  {i === 0 && ' · latest'}
                </div>
              </div>
              <Button size="sm" variant="ghost" className="opacity-70 group-hover:opacity-100" disabled={!!undoing || busy} onClick={() => void undo(c.commit, c.subject)}>
                {undoing === c.commit ? <Spinner className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />} Undo to here
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
