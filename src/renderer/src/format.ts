export const fmtInt = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '–' : Math.round(n).toLocaleString('en-US'))

export function fmtTps(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '–'
  return n >= 100 ? n.toFixed(0) : n.toFixed(1)
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return `${m}m ${rs}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function fmtMiB(mib: number | null | undefined): string {
  if (mib === null || mib === undefined || !Number.isFinite(mib)) return '–'
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`
}

export function fmtBytes(b: number | undefined): string {
  if (b === undefined) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export function timeAgo(t: number): string {
  const d = (Date.now() - t) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return new Date(t).toLocaleDateString()
}

/** Language for highlight.js from a filename. */
export function langOf(file: string): string | undefined {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    h: 'cpp',
    c: 'c',
    cmake: 'cmake',
    txt: file.toLowerCase().endsWith('cmakelists.txt') ? 'cmake' : 'plaintext',
    toml: 'ini',
    ini: 'ini',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'xml',
    xml: 'xml',
    svg: 'xml',
    css: 'css',
    sh: 'bash',
    bash: 'bash',
    go: 'go',
    java: 'java',
    sql: 'sql',
    diff: 'diff',
  }
  return map[ext]
}

/** "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M" -> "Qwen3.8-27B · UD-Q4_K_M" */
export function prettyModel(id: string): string {
  const [m, q] = (id.split('/').pop() ?? id).split(':')
  const base = m.replace(/-GGUF$/i, '').replace(/\.gguf$/i, '')
  return q ? `${base} · ${q}` : base
}
