import { useCallback, useEffect, useMemo, useState } from 'react'
import hljs from 'highlight.js'
import { ChevronRight, File, Folder, Link2, RefreshCw } from 'lucide-react'
import type { FileContent, FileNode } from '@shared/api'
import { api, errMsg } from '../../api'
import { useStore } from '../../store'
import { cx, IconButton, Spinner } from '../ui'
import { fmtBytes, langOf } from '../../format'

function TreeNode({ node, depth, onOpen, selected, version }: { node: FileNode; depth: number; onOpen: (n: FileNode) => void; selected: string | null; version: number }) {
  const projectId = useStore((s) => s.projectId)!
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileNode[] | null>(null)
  useEffect(() => {
    if (open && node.type === 'dir') void api.listDir(projectId, node.path).then(setChildren).catch(() => setChildren([]))
  }, [open, node, projectId, version])
  return (
    <div>
      <div
        className={cx(
          'flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-[3px] text-[12.5px]',
          selected === node.path ? 'bg-accent-soft text-fg' : 'hover:bg-hover',
          node.heavy && 'opacity-55',
        )}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => (node.type === 'dir' ? setOpen(!open) : onOpen(node))}
      >
        {node.type === 'dir' ? (
          <>
            <ChevronRight className={cx('h-3 w-3 shrink-0 text-faint transition-transform', open && 'rotate-90')} />
            <Folder className="h-3.5 w-3.5 shrink-0 text-accent/80" />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {node.type === 'symlink' ? <Link2 className="h-3.5 w-3.5 shrink-0 text-faint" /> : <File className="h-3.5 w-3.5 shrink-0 text-muted" />}
          </>
        )}
        <span className="truncate">{node.name}</span>
        {node.type === 'file' && <span className="ml-auto shrink-0 pl-2 text-[10.5px] text-faint">{fmtBytes(node.size)}</span>}
      </div>
      {open && children && children.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} onOpen={onOpen} selected={selected} version={version} />)}
    </div>
  )
}

function Viewer({ file }: { file: FileContent }) {
  const html = useMemo(() => {
    if (file.content === null) return null
    const lang = langOf(file.path)
    try {
      return lang && hljs.getLanguage(lang) ? hljs.highlight(file.content, { language: lang }).value : hljs.highlightAuto(file.content.slice(0, 200_000)).value
    } catch {
      return null
    }
  }, [file])
  if (file.dataUrl) return <img src={file.dataUrl} alt={file.path} className="max-w-full rounded border border-line" />
  if (file.binary) return <div className="text-[12.5px] text-muted">Binary file ({fmtBytes(file.size)}).</div>
  const lines = (file.content ?? '').split('\n')
  return (
    <div className="flex font-mono text-[12px] leading-[1.55]">
      <div className="select-none pr-3 text-right text-faint">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {html !== null ? (
        <pre className="selectable hljs min-w-0 flex-1 whitespace-pre bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="selectable min-w-0 flex-1 whitespace-pre">{file.content}</pre>
      )}
    </div>
  )
}

export function FilesPanel() {
  const projectId = useStore((s) => s.projectId)
  const [roots, setRoots] = useState<FileNode[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const refresh = useCallback(() => {
    if (!projectId) return
    setVersion((v) => v + 1)
    api
      .listDir(projectId, '')
      .then(setRoots)
      .catch((e) => setError(errMsg(e)))
  }, [projectId])

  useEffect(() => {
    setRoots(null)
    setFile(null)
    setSelected(null)
    refresh()
  }, [refresh])

  const open = async (n: FileNode) => {
    if (!projectId) return
    setSelected(n.path)
    setLoading(true)
    setError(null)
    try {
      setFile(await api.readFile(projectId, n.path))
    } catch (e) {
      setError(errMsg(e))
      setFile(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="files-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12.5px] text-muted">
        <span>Project files</span>
        <IconButton className="ml-auto" onClick={refresh} title="Refresh">
          <RefreshCw className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="h-[38%] min-h-[120px] overflow-y-auto border-b border-line p-1.5">
        {roots === null ? <Spinner className="m-2 h-4 w-4" /> : roots.map((n) => <TreeNode key={n.path} node={n} depth={0} onOpen={(x) => void open(x)} selected={selected} version={version} />)}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && <div className="text-[12px] text-bad">{error}</div>}
        {loading && <Spinner />}
        {!loading && file && (
          <>
            <div className="mb-2 flex items-center gap-2 font-mono text-[12px] text-muted">
              <span className="truncate">{file.path}</span>
              <span className="ml-auto shrink-0 text-faint">
                {fmtBytes(file.size)}
                {file.truncated ? ' (truncated)' : ''}
              </span>
            </div>
            <Viewer file={file} />
          </>
        )}
        {!loading && !file && !error && <div className="text-[12.5px] text-faint">Select a file to view it.</div>}
      </div>
    </div>
  )
}
