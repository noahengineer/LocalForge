import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'

export interface PodmanStorage {
  /** Storage root ('' = podman default). */
  root: string
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export class PodmanError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message)
  }
}

/** Thin wrapper over the podman CLI. Every call gets the configured storage flags. */
export class Podman {
  constructor(private readonly storage: () => PodmanStorage) {}

  /** Global flags placed before the subcommand. */
  globalArgs(): string[] {
    const { root } = this.storage()
    if (!root) return []
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`
    return ['--root', path.join(root, 'storage'), '--runroot', path.join(runtimeDir, 'localforge-containers')]
  }

  /** Same command as a string, for logs/README ("podman --root ... ps"). */
  describe(args: string[]): string {
    return ['podman', ...this.globalArgs(), ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
  }

  run(args: string[], opts: { input?: string | Buffer; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const p = spawn('podman', [...this.globalArgs(), ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...opts.env },
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let timer: NodeJS.Timeout | null = null
      if (opts.timeoutMs) {
        timer = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs)
      }
      p.stdout.on('data', (c: Buffer) => out.push(c))
      p.stderr.on('data', (c: Buffer) => err.push(c))
      p.on('error', (e) => {
        if (timer) clearTimeout(timer)
        reject(e)
      })
      p.on('close', (code) => {
        if (timer) clearTimeout(timer)
        resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      })
      if (opts.input !== undefined) p.stdin.end(opts.input)
      else p.stdin.end()
    })
  }

  /** Run and throw on non-zero exit. */
  async ok(args: string[], opts: { input?: string | Buffer; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.run(args, opts)
    if (r.code !== 0) throw new PodmanError(`podman ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`, r)
    return r.stdout
  }

  /** Spawn a long-running podman process and stream its combined output line by line. */
  stream(args: string[], onLine: (line: string) => void): { child: ChildProcess; done: Promise<number> } {
    const child = spawn('podman', [...this.globalArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    createInterface({ input: child.stdout! }).on('line', onLine)
    createInterface({ input: child.stderr! }).on('line', onLine)
    const done = new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? -1))
    })
    return { child, done }
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.run(['version', '--format', '{{.Client.Version}}'], { timeoutMs: 10000 })
      return r.code === 0 ? r.stdout.trim() : null
    } catch {
      return null
    }
  }

  async imageExists(ref: string): Promise<boolean> {
    const r = await this.run(['image', 'exists', ref])
    return r.code === 0
  }

  async containerExists(name: string): Promise<boolean> {
    const r = await this.run(['container', 'exists', name])
    return r.code === 0
  }

  async volumeExists(name: string): Promise<boolean> {
    const r = await this.run(['volume', 'exists', name])
    return r.code === 0
  }

  /** `podman inspect` state for a container, or null if it doesn't exist. */
  async containerState(name: string): Promise<{ status: string; running: boolean; image: string; startedAt: string } | null> {
    const r = await this.run(['container', 'inspect', '--format', '{{json .State}}|{{.ImageName}}', name])
    if (r.code !== 0) return null
    const [stateJson, image] = r.stdout.trim().split('|')
    try {
      const st = JSON.parse(stateJson) as { Status: string; Running: boolean; StartedAt: string }
      return { status: st.Status, running: st.Running, image: image ?? '', startedAt: st.StartedAt }
    } catch {
      return null
    }
  }

  /** Host port mapped to a container port, e.g. 4096 -> 43123. */
  async hostPort(name: string, containerPort: number): Promise<number | null> {
    const r = await this.run(['port', name, `${containerPort}/tcp`])
    if (r.code !== 0) return null
    const m = /:(\d+)\s*$/m.exec(r.stdout.trim())
    return m ? Number(m[1]) : null
  }
}

export interface ContainerStats {
  name: string
  cpuPct: number
  memUsedMiB: number
  memLimitMiB: number
}

/** Parse a podman size string such as "1.2GB", "512.3MiB", "800kB". */
export function parseSize(s: string): number {
  const m = /^\s*([\d.]+)\s*([kKmMgGtT]?)(i?)[bB]?\s*$/.exec(s)
  if (!m) return 0
  const v = Number(m[1])
  const unit = m[2].toUpperCase()
  const base = m[3] ? 1024 : 1000
  const pow = { '': 0, K: 1, M: 2, G: 3, T: 4 }[unit] ?? 0
  return (v * base ** pow) / (1024 * 1024)
}

/** Parse `podman stats --no-stream --format json` output. */
export function parseStats(json: string): ContainerStats[] {
  let arr: Array<Record<string, unknown>>
  try {
    arr = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr.map((e) => {
    const name = String(e.name ?? e.Name ?? '')
    const cpu = String(e.cpu_percent ?? e.CPU ?? e.cpu ?? '0').replace('%', '')
    const memUsage = String(e.mem_usage ?? e.MemUsage ?? '')
    const [used, limit] = memUsage.split('/').map((x) => parseSize(x))
    return { name, cpuPct: Number.parseFloat(cpu) || 0, memUsedMiB: used ?? 0, memLimitMiB: limit ?? 0 }
  })
}
