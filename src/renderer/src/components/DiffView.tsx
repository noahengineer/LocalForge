import { useMemo } from 'react'
import { cx } from './ui'

export interface DiffFile {
  path: string
  lines: Array<{ kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; oldNo?: number; newNo?: number }>
  additions: number
  deletions: number
}

/** Parse a (possibly multi-file) unified diff. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let oldNo = 0
  let newNo = 0
  const start = (p: string) => {
    cur = { path: p, lines: [], additions: 0, deletions: 0 }
    files.push(cur)
  }
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(raw)
      start(m ? m[1] : raw.slice(11))
      continue
    }
    if (raw.startsWith('Index: ')) {
      start(raw.slice(7))
      continue
    }
    if (!cur) start('')
    const f = cur as unknown as DiffFile
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) {
      if (raw.startsWith('+++ ') && !f.path) f.path = raw.slice(4).replace(/^b\//, '')
      continue
    }
    if (/^(index |new file mode|deleted file mode|similarity|rename |old mode|new mode|=+$)/.test(raw)) continue
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      f.lines.push({ kind: 'hunk', text: raw })
    } else if (raw.startsWith('+')) {
      f.lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ })
      f.additions++
    } else if (raw.startsWith('-')) {
      f.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ })
      f.deletions++
    } else if (raw.startsWith('\\')) {
      f.lines.push({ kind: 'meta', text: raw })
    } else if (raw.length > 0 || f.lines.length > 0) {
      f.lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files.filter((x) => x.lines.length > 0 || x.path)
}

export function DiffFileView({ file, maxLines = 400, showHeader = true }: { file: DiffFile; maxLines?: number; showHeader?: boolean }) {
  const lines = file.lines.slice(0, maxLines)
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-code">
      {showHeader && (
        <div className="flex items-center justify-between border-b border-line px-3 py-1.5 font-mono text-[12px]">
          <span className="truncate text-fg">{file.path || '(diff)'}</span>
          <span className="shrink-0 pl-3">
            <span className="text-ok">+{file.additions}</span> <span className="text-bad">−{file.deletions}</span>
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={cx(l.kind === 'add' && 'diff-add', l.kind === 'del' && 'diff-del')}>
                <td className="w-10 select-none pr-2 text-right align-top text-faint">{l.kind === 'hunk' || l.kind === 'meta' ? '' : (l.oldNo ?? '')}</td>
                <td className="w-10 select-none pr-2 text-right align-top text-faint">{l.kind === 'hunk' || l.kind === 'meta' ? '' : (l.newNo ?? '')}</td>
                <td className={cx('w-4 select-none align-top', l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-bad' : 'text-faint')}>
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                </td>
                <td className={cx('whitespace-pre pr-4 selectable', l.kind === 'hunk' && 'diff-hunk', l.kind === 'meta' && 'text-faint italic')}>{l.text || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {file.lines.length > maxLines && <div className="px-3 py-1.5 text-[12px] text-muted">… {file.lines.length - maxLines} more lines</div>}
      </div>
    </div>
  )
}

export function DiffView({ diff, maxLines }: { diff: string; maxLines?: number }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  if (!diff.trim()) return <div className="text-[12.5px] text-muted">No changes.</div>
  return (
    <div className="space-y-3">
      {files.map((f, i) => (
        <DiffFileView key={i} file={f} maxLines={maxLines} />
      ))}
    </div>
  )
}
