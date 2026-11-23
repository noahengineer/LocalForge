import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CachedModel, HfModelInfo, ModelsInfo } from '../../shared/api'

const execFileP = promisify(execFile)

/**
 * Switching the model llama-server runs. The user's unit file is never edited: LocalForge writes a
 * systemd drop-in (<unit>.d/localforge-model.conf) that replaces ExecStart with the same command line
 * except for the model arguments. Removing the drop-in restores the original exactly.
 */

export const DROPIN_NAME = 'localforge-model.conf'

/** Split a systemd ExecStart command line (handles '...' and "..." quoting). */
export function tokenize(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inTok = false
  let q: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && i + 1 < line.length) cur += line[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      q = c
      inTok = true
    } else if (/\s/.test(c)) {
      if (inTok) out.push(cur)
      cur = ''
      inTok = false
    } else {
      cur += c
      inTok = true
    }
  }
  if (inTok) out.push(cur)
  return out
}

/** Quote one argument for an ExecStart line. */
export function quoteArg(a: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a
  if (!a.includes("'")) return `'${a}'`
  return `"${a.replace(/(["\\])/g, '\\$1')}"`
}

/**
 * Flags whose values belong to one model's chat template (e.g. reasoning_effort "high" is valid for
 * one Qwen template and an error in another). They are kept for the original model only.
 */
const TEMPLATE_FLAGS_WITH_VALUE = new Set(['--chat-template-kwargs', '--chat-template', '--chat-template-file'])

const MODEL_FLAGS_WITH_VALUE = new Set(['-hf', '-hfr', '--hf-repo', '-hff', '--hf-file', '-m', '--model', '-mm', '--mmproj', '-mu', '--model-url'])

/** The model the command line runs: { kind, spec }. */
export function modelOf(args: string[]): { kind: 'hf' | 'file' | 'unknown'; spec: string | null } {
  for (let i = 0; i < args.length - 1; i++) {
    if (['-hf', '-hfr', '--hf-repo'].includes(args[i])) return { kind: 'hf', spec: args[i + 1] }
    if (['-m', '--model'].includes(args[i])) return { kind: 'file', spec: args[i + 1] }
  }
  return { kind: 'unknown', spec: null }
}

/** Same command line with a different model. A path ending in .gguf runs a local file; anything else is a Hugging Face spec. */
export function withModel(args: string[], spec: string, mmproj: string | null = null, dropTemplateFlags = true): string[] {
  const rest: string[] = []
  for (let i = 1; i < args.length; i++) {
    if (MODEL_FLAGS_WITH_VALUE.has(args[i]) || (dropTemplateFlags && TEMPLATE_FLAGS_WITH_VALUE.has(args[i]))) {
      i++
      continue
    }
    rest.push(args[i])
  }
  const isFile = spec.startsWith('/') && spec.toLowerCase().endsWith('.gguf')
  const model = isFile ? ['-m', spec, ...(mmproj ? ['--mmproj', mmproj] : [])] : ['-hf', spec]
  return [args[0], ...model, ...rest]
}

async function sh(cmd: string, args: string[]): Promise<string> {
  return (await execFileP(cmd, args, { timeout: 30_000 })).stdout.trim()
}

export async function unitFile(unit: string): Promise<string | null> {
  try {
    const p = await sh('systemctl', ['--user', 'show', '-p', 'FragmentPath', '--value', unit])
    return p || null
  } catch {
    return null
  }
}

export function dropinPath(unitPath: string): string {
  return path.join(path.dirname(unitPath), `${path.basename(unitPath)}.d`, DROPIN_NAME)
}

/** The ExecStart of the user's own unit file (ignores drop-ins). */
export function readExecStart(unitPath: string): string[] {
  const text = readFileSync(unitPath, 'utf8')
  const lines = text.split('\n').filter((l) => /^\s*ExecStart\s*=/.test(l))
  const last = lines[lines.length - 1]
  if (!last) throw new Error(`no ExecStart in ${unitPath}`)
  return tokenize(last.replace(/^\s*ExecStart\s*=\s*/, ''))
}

/** The command line currently in effect (drop-in if present, else the unit file). */
export function effectiveArgs(unitPath: string): string[] {
  const d = dropinPath(unitPath)
  if (existsSync(d)) {
    const lines = readFileSync(d, 'utf8')
      .split('\n')
      .filter((l) => /^\s*ExecStart\s*=\s*\S/.test(l))
    if (lines.length) return tokenize(lines[lines.length - 1].replace(/^\s*ExecStart\s*=\s*/, ''))
  }
  return readExecStart(unitPath)
}

const QUANT_RE = /((?:UD-)?(?:IQ|Q)\d[A-Za-z0-9_]*|BF16|F16|F32|MXFP4[A-Za-z0-9_]*)$/i

/** "Qwen3.8-27B-UD-Q4_K_M.gguf" -> "UD-Q4_K_M" */
export function quantOf(file: string): string | null {
  const base = path.basename(file).replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/, '')
  return QUANT_RE.exec(base)?.[1] ?? null
}

function dirSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/** Models already downloaded: llama.cpp's Hugging Face cache and ~/models. */
export function listCachedModels(home = os.homedir()): CachedModel[] {
  const out: CachedModel[] = []
  const hub = path.join(process.env.HF_HOME ?? path.join(home, '.cache', 'huggingface'), 'hub')
  if (existsSync(hub)) {
    for (const d of readdirSync(hub)) {
      const m = /^models--([^-][^]*?)--(.+)$/.exec(d)
      if (!m) continue
      const repo = `${m[1]}/${m[2]}`
      const snaps = path.join(hub, d, 'snapshots')
      if (!existsSync(snaps)) continue
      for (const snap of readdirSync(snaps)) {
        const dir = path.join(snaps, snap)
        let files: string[]
        try {
          files = readdirSync(dir, { recursive: true }) as string[]
        } catch {
          continue
        }
        const ggufs = files.filter((f) => f.toLowerCase().endsWith('.gguf'))
        const mmproj = ggufs.find((f) => /mmproj/i.test(path.basename(f)))
        for (const f of ggufs) {
          if (/mmproj/i.test(path.basename(f))) continue
          if (/-\d{5}-of-\d{5}\.gguf$/i.test(f) && !/-00001-of-/i.test(f)) continue
          const q = quantOf(f)
          const parts = /-00001-of-\d{5}\.gguf$/i.test(f) ? ggufs.filter((g) => g.replace(/-\d{5}-of-/, '') === f.replace(/-\d{5}-of-/, '')) : [f]
          out.push({
            spec: q ? `${repo}:${q}` : path.join(dir, f),
            repo,
            file: path.basename(f),
            path: path.join(dir, f),
            sizeBytes: parts.reduce((a, g) => a + dirSize(path.join(dir, g)), 0),
            vision: !!mmproj,
          })
        }
      }
    }
  }
  const local = path.join(home, 'models')
  if (existsSync(local)) {
    for (const f of readdirSync(local)) {
      if (!f.toLowerCase().endsWith('.gguf') || /mmproj/i.test(f)) continue
      const p = path.join(local, f)
      const mm = readdirSync(local).find((g) => /mmproj/i.test(g) && g.toLowerCase().endsWith('.gguf'))
      out.push({ spec: p, repo: null, file: f, path: p, sizeBytes: dirSize(p), vision: !!mm })
    }
  }
  return out.sort((a, b) => a.spec.localeCompare(b.spec))
}

export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export async function modelsInfo(unit: string): Promise<ModelsInfo> {
  const up = await unitFile(unit)
  const cacheDir = path.join(process.env.HF_HOME ?? path.join(os.homedir(), '.cache', 'huggingface'), 'hub')
  if (!up || !existsSync(up)) {
    return { parallel: null, unitPath: null, current: null, original: null, overridden: false, cached: listCachedModels(), cacheDir, freeBytes: freeBytes(path.dirname(cacheDir)), error: `systemd unit ${unit} not found` }
  }
  const original = modelOf(readExecStart(up)).spec
  const current = modelOf(effectiveArgs(up)).spec
  return {
    parallel: parallelOf(effectiveArgs(up)),
    unitPath: up,
    current,
    original,
    overridden: existsSync(dropinPath(up)),
    cached: listCachedModels(),
    cacheDir,
    freeBytes: freeBytes(existsSync(cacheDir) ? cacheDir : os.homedir()),
    error: null,
  }
}

/** Point llama-server at another model (drop-in + daemon-reload + restart). */
export interface ServerOptions {
  /**
   * Run llama-server with one slot (-np 1). With the default auto (4 slots) all conversations share
   * one KV pool of the context size, so two busy ones (e.g. parallel subagents) can together exceed
   * it and both fail with "Context size has been exceeded". One slot gives every conversation the
   * full context; others wait their turn, and idle ones are kept in llama-server's RAM prompt cache.
   */
  singleSlot: boolean
}

const PARALLEL_FLAGS = new Set(['-np', '--parallel'])

/** The command line with LocalForge's server options applied. */
export function withServerOptions(args: string[], opts: ServerOptions): string[] {
  if (!opts.singleSlot) return args
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (PARALLEL_FLAGS.has(args[i])) {
      i++
      continue
    }
    out.push(args[i])
  }
  return [...out, '-np', '1']
}

/** Write (or remove, when nothing differs from the unit file) LocalForge's drop-in. */
export function writeDropin(unitPath: string, modelArgs: string[], opts: ServerOptions): void {
  const base = readExecStart(unitPath)
  const args = withServerOptions(modelArgs, opts)
  const d = dropinPath(unitPath)
  if (args.join('\0') === base.join('\0')) {
    rmSync(d, { force: true })
    return
  }
  mkdirSync(path.dirname(d), { recursive: true })
  writeFileSync(
    d,
    `# Written by LocalForge (Settings -> Model). Delete this file to go back to ${path.basename(unitPath)} exactly.\n` +
      `# A model other than the unit's own leaves out its chat-template options (--chat-template-kwargs etc.).\n` +
      (opts.singleSlot ? `# -np 1: one conversation at a time, each with the full context.\n` : '') +
      `[Service]\nExecStart=\nExecStart=${args.map(quoteArg).join(' ')}\n`,
  )
}

/** Apply server options to whatever model is configured now (drop-in + restart). */
export async function applyServerOptions(unit: string, opts: ServerOptions): Promise<{ args: string[] }> {
  const up = await unitFile(unit)
  if (!up || !existsSync(up)) throw new Error(`systemd unit ${unit} not found`)
  const base = readExecStart(up)
  const cur = effectiveArgs(up)
  const sameModel = modelOf(cur).spec === modelOf(base).spec
  // Keep the current model arguments (and, for the unit's own model, its template options).
  const mmIdx = cur.indexOf('--mmproj')
  const modelArgs = sameModel ? base : withModel(base, modelOf(cur).spec!, mmIdx >= 0 ? cur[mmIdx + 1] : null)
  writeDropin(up, modelArgs, opts)
  await sh('systemctl', ['--user', 'daemon-reload'])
  await sh('systemctl', ['--user', 'restart', unit])
  return { args: effectiveArgs(up) }
}

/** The number of slots the configured command line asks for (null = llama-server's auto). */
export function parallelOf(args: string[]): number | null {
  for (let i = 0; i < args.length - 1; i++) if (PARALLEL_FLAGS.has(args[i])) return Number(args[i + 1])
  return null
}

export async function switchModel(unit: string, spec: string, opts: ServerOptions = { singleSlot: false }): Promise<{ args: string[]; dropin: string | null }> {
  const up = await unitFile(unit)
  if (!up || !existsSync(up)) throw new Error(`systemd unit ${unit} not found`)
  const base = readExecStart(up)
  const d = dropinPath(up)
  const s = spec.trim()
  if (!s) throw new Error('No model given')
  const isFile = s.startsWith('/')
  if (isFile && !existsSync(s)) throw new Error(`${s} does not exist`)
  if (!isFile && !/^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/.test(s)) throw new Error('Use a Hugging Face repo like org/name-GGUF or org/name-GGUF:Q4_K_M, or a path to a .gguf file')
  let mmproj: string | null = null
  if (isFile) {
    const dir = path.dirname(s)
    const mm = readdirSync(dir).find((f) => /mmproj/i.test(f) && f.toLowerCase().endsWith('.gguf'))
    if (mm) mmproj = path.join(dir, mm)
  }
  writeDropin(up, s === modelOf(base).spec ? base : withModel(base, s, mmproj), opts)
  await sh('systemctl', ['--user', 'daemon-reload'])
  await sh('systemctl', ['--user', 'restart', unit])
  return { args: effectiveArgs(up), dropin: existsSync(d) ? d : null }
}

/**
 * The Settings -> Model reasoning effort, applied to one chat request. 'none' (no thinking) is
 * handled by llama-server for any template; a level is only sent when the loaded model accepts it.
 * An invalid level would make the chat template raise an error on every request.
 */
export function applyReasoningEffort(body: Record<string, unknown>, effort: string, levels: string[] | null): Record<string, unknown> {
  if (!effort || !Array.isArray(body.messages)) return body
  if (effort !== 'none' && !levels?.includes(effort)) return body
  return { ...body, reasoning_effort: effort }
}

/** Look up a Hugging Face repo's GGUF files (for the "Get a new model" box). */
export async function lookupHfModel(repo: string): Promise<HfModelInfo> {
  const r = repo.trim().replace(/^https?:\/\/huggingface\.co\//, '').split(':')[0]
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('Use the form org/repo, e.g. unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF')
  const res = await fetch(`https://huggingface.co/api/models/${r}?blobs=true`, { signal: AbortSignal.timeout(20_000) })
  if (res.status === 404 || res.status === 401) throw new Error(`Repository ${r} not found (or it needs a login)`)
  if (!res.ok) throw new Error(`Hugging Face: HTTP ${res.status}`)
  const j = (await res.json()) as { siblings?: Array<{ rfilename: string; size?: number }>; gated?: unknown }
  const files = (j.siblings ?? []).filter((f) => f.rfilename.toLowerCase().endsWith('.gguf'))
  const vision = files.some((f) => /mmproj/i.test(f.rfilename))
  const byQuant = new Map<string, number>()
  for (const f of files) {
    if (/mmproj/i.test(f.rfilename)) continue
    const q = quantOf(f.rfilename)
    if (!q) continue
    byQuant.set(q, (byQuant.get(q) ?? 0) + (f.size ?? 0))
  }
  if (byQuant.size === 0) throw new Error(`${r} has no GGUF model files llama.cpp can use`)
  return {
    repo: r,
    gated: !!j.gated,
    vision,
    quants: [...byQuant.entries()].map(([quant, sizeBytes]) => ({ quant, sizeBytes, spec: `${r}:${quant}` })).sort((a, b) => a.sizeBytes - b.sizeBytes),
  }
}
