import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FileContent, FileNode } from '../../shared/api'

export const HEAVY_DIRS = new Set(['node_modules', '.git', 'build', 'target', '.venv', 'dist', 'out', 'vcpkg_installed', '__pycache__', '.cache', 'graphify-out', '.playwright-mcp'])

const MAX_TEXT = 1024 * 1024 // 1 MiB shown in the viewer
const MAX_IMAGE = 8 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
}

/**
 * Resolve a project-relative path safely. The project folder is writable by the sandboxed agent,
 * so it may contain symlinks pointing anywhere on the host: every access is checked against the
 * real path of the project root and anything resolving outside it is refused.
 */
export async function safeResolve(root: string, rel: string): Promise<string> {
  const realRoot = await realpath(root)
  const joined = path.resolve(realRoot, '.' + path.sep + rel)
  if (joined !== realRoot && !joined.startsWith(realRoot + path.sep)) throw new Error('path escapes the project')
  const real = await realpath(joined)
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('path resolves outside the project')
  return real
}

export async function listDir(root: string, rel: string): Promise<FileNode[]> {
  const dir = await safeResolve(root, rel)
  const entries = await readdir(dir, { withFileTypes: true })
  const out: FileNode[] = []
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) {
      out.push({ name: e.name, path: childRel, type: 'symlink' })
    } else if (e.isDirectory()) {
      out.push({ name: e.name, path: childRel, type: 'dir', heavy: HEAVY_DIRS.has(e.name) })
    } else if (e.isFile()) {
      let size: number | undefined
      try {
        size = (await lstat(path.join(dir, e.name))).size
      } catch {
        /* raced */
      }
      out.push({ name: e.name, path: childRel, type: 'file', size })
    }
  }
  out.sort((a, b) => {
    const da = a.type === 'dir' ? 0 : 1
    const db = b.type === 'dir' ? 0 : 1
    if (da !== db) return da - db
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return out
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function readProjectFile(root: string, rel: string): Promise<FileContent> {
  const file = await safeResolve(root, rel)
  const st = await stat(file)
  if (!st.isFile()) throw new Error('not a file')
  const ext = path.extname(file).toLowerCase()
  const mime = IMAGE_MIME[ext] ?? null
  if (mime) {
    if (st.size > MAX_IMAGE) return { path: rel, content: null, binary: true, size: st.size, truncated: true, mime, dataUrl: null }
    const buf = await readFile(file)
    return { path: rel, content: null, binary: true, size: st.size, truncated: false, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  }
  const fh = await readFile(file)
  const buf = fh.subarray(0, MAX_TEXT)
  if (looksBinary(buf)) return { path: rel, content: null, binary: true, size: st.size, truncated: false, mime: null, dataUrl: null }
  return { path: rel, content: buf.toString('utf8'), binary: false, size: st.size, truncated: st.size > MAX_TEXT, mime: null, dataUrl: null }
}
