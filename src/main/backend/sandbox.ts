import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Podman, RunResult } from './podman'
import { parseStats } from './podman'
import type { Project, SandboxStatus } from '../../shared/api'
import type { Settings } from '../../shared/settings'

export const OPENCODE_PORT = 4096
export const NOVNC_PORT = 6080
export const CONTAINER_USER_HOME = '/home/dev'

export const containerName = (projectId: string) => `localforge-${projectId}`
export const stateVolumeName = (projectId: string) => `localforge-${projectId}-opencode`

function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Arguments for `podman create`. Security model:
 * - only the project folder is mounted (at /workspace); no host home, sockets or devices;
 * - rootless podman + keep-id: the agent runs as `dev` (uid 1000) which maps to the host user
 *   for /workspace files, while container root maps to an unprivileged subordinate uid;
 * - pasta networking gives internet access; `-T <proxyPort>` forwards ONLY the container's
 *   127.0.0.1:<proxyPort> to the host's 127.0.0.1:<proxyPort> (the stats proxy). Other host
 *   loopback services, including llama-server itself, are unreachable from the sandbox;
 * - OpenCode and noVNC are published on the host's 127.0.0.1 only, on random ports;
 * - CPU/RAM/pids limits from settings.
 * OpenCode's own state (sessions, undo snapshots) lives in a named volume so it survives
 * "Reset sandbox".
 */
export function createArgs(p: {
  projectId: string
  projectName: string
  projectPath: string
  image: string
  settings: Settings
  password: string
}): string[] {
  const s = p.settings
  const hostname = p.projectName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sandbox'
  return [
    'create',
    '--name',
    containerName(p.projectId),
    '--hostname',
    hostname,
    '--label',
    `localforge.project=${p.projectId}`,
    '--init',
    '--userns=keep-id:uid=1000,gid=1000',
    '--network',
    `pasta:-T,${s.proxy.port}`,
    '-p',
    `127.0.0.1::${OPENCODE_PORT}`,
    '-p',
    `127.0.0.1::${NOVNC_PORT}`,
    '--cpus',
    String(s.sandbox.cpus),
    '--memory',
    `${s.sandbox.memoryGb}g`,
    '--memory-swap',
    `${s.sandbox.memoryGb}g`,
    '--pids-limit',
    '8192',
    '--shm-size',
    '2g',
    '-v',
    `${p.projectPath}:/workspace`,
    '-v',
    `${stateVolumeName(p.projectId)}:${CONTAINER_USER_HOME}/.local/share/opencode:U`,
    '-e',
    `OPENCODE_SERVER_PASSWORD=${p.password}`,
    '-e',
    `LOCALFORGE_SCREEN=${s.sandbox.screen}`,
    '-e',
    `TZ=${hostTimezone()}`,
    // `nproc` inside the container still reports every host CPU, so tell the common build tools
    // how many jobs the CPU limit actually allows.
    ...['CMAKE_BUILD_PARALLEL_LEVEL', 'CARGO_BUILD_JOBS', 'VCPKG_MAX_CONCURRENCY'].flatMap((k) => ['-e', `${k}=${s.sandbox.cpus}`]),
    '-e',
    `MAKEFLAGS=-j${s.sandbox.cpus}`,
    p.image,
  ]
}

export interface SandboxRuntime {
  opencodePort: number
  novncPort: number
  password: string
}

/** Manages one rootless container per project. */
export class SandboxManager extends EventEmitter<{ status: [SandboxStatus] }> {
  private statuses = new Map<string, SandboxStatus>()
  private passwords = new Map<string, string>()
  private locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly podman: Podman,
    private readonly settings: () => Settings,
  ) {
    super()
  }

  status(projectId: string): SandboxStatus {
    return (
      this.statuses.get(projectId) ?? {
        projectId,
        state: 'missing',
        container: containerName(projectId),
        image: null,
        opencodePort: null,
        novncPort: null,
        opencodeReady: false,
        cpuPct: null,
        memUsedMiB: null,
        memLimitMiB: null,
        error: null,
      }
    )
  }

  setStatus(projectId: string, patch: Partial<SandboxStatus>): SandboxStatus {
    const st = { ...this.status(projectId), ...patch }
    this.statuses.set(projectId, st)
    this.emit('status', st)
    return st
  }

  /** Serialize lifecycle operations per project. */
  private withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.locks.set(projectId, next)
    return next.finally(() => {
      if (this.locks.get(projectId) === next) this.locks.delete(projectId)
    })
  }

  /** Read the container's OpenCode password (stored in its environment). */
  private async passwordOf(projectId: string): Promise<string> {
    const cached = this.passwords.get(projectId)
    if (cached) return cached
    const out = await this.podman.ok(['container', 'inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', containerName(projectId)])
    const line = out.split('\n').find((l) => l.startsWith('OPENCODE_SERVER_PASSWORD='))
    if (!line) throw new Error('sandbox has no OpenCode password')
    const pw = line.slice('OPENCODE_SERVER_PASSWORD='.length)
    this.passwords.set(projectId, pw)
    return pw
  }

  async refresh(projectId: string): Promise<SandboxStatus> {
    const st = await this.podman.containerState(containerName(projectId))
    if (!st) return this.setStatus(projectId, { state: 'missing', opencodePort: null, novncPort: null, opencodeReady: false })
    if (!st.running) return this.setStatus(projectId, { state: 'stopped', image: st.image, opencodeReady: false })
    const [oc, vnc] = await Promise.all([this.podman.hostPort(containerName(projectId), OPENCODE_PORT), this.podman.hostPort(containerName(projectId), NOVNC_PORT)])
    return this.setStatus(projectId, { state: 'running', image: st.image, opencodePort: oc, novncPort: vnc })
  }

  /**
   * Make sure the project's container exists and runs, with the OpenCode config written.
   * Returns the runtime info (ports + password) once OpenCode is reachable.
   */
  ensureRunning(project: Project, image: string, opencodeConfig: string): Promise<SandboxRuntime> {
    return this.withLock(project.id, async () => {
      const name = containerName(project.id)
      try {
        let st = await this.podman.containerState(name)
        if (!st) {
          this.setStatus(project.id, { state: 'creating', error: null, image })
          const password = randomBytes(24).toString('base64url')
          await this.podman.ok(
            createArgs({ projectId: project.id, projectName: project.name, projectPath: project.path, image, settings: this.settings(), password }),
            { timeoutMs: 300_000 },
          )
          this.passwords.set(project.id, password)
          st = await this.podman.containerState(name)
        }
        if (!st?.running) {
          this.setStatus(project.id, { state: 'starting', error: null })
          await this.podman.ok(['start', name], { timeoutMs: 120_000 })
        }
        await this.writeOpenCodeConfig(project.id, opencodeConfig)
        const status = await this.refresh(project.id)
        if (!status.opencodePort || !status.novncPort) throw new Error('could not determine published ports')
        return { opencodePort: status.opencodePort, novncPort: status.novncPort, password: await this.passwordOf(project.id) }
      } catch (e) {
        this.setStatus(project.id, { state: 'error', error: e instanceof Error ? e.message : String(e) })
        throw e
      }
    })
  }

  /** Write ~/.config/opencode/opencode.json inside the container; restart OpenCode if it changed. */
  async writeOpenCodeConfig(projectId: string, json: string): Promise<boolean> {
    const name = containerName(projectId)
    const path = `${CONTAINER_USER_HOME}/.config/opencode/opencode.json`
    const cur = await this.podman.run(['exec', name, 'cat', path])
    if (cur.code === 0 && cur.stdout === json) return false
    await this.podman.ok(['exec', '-i', name, 'bash', '-c', `mkdir -p "$(dirname ${path})" && cat > ${path}.tmp && mv ${path}.tmp ${path}`], { input: json })
    if (cur.code === 0) {
      // Config existed before: restart OpenCode so it picks up the change.
      await this.podman.run(['exec', name, 'supervisorctl', '-c', '/opt/localforge/supervisord.conf', 'restart', 'opencode'])
    }
    return true
  }

  /** Write a file inside the container (as `dev`), creating parent folders. */
  async writeFile(projectId: string, absPath: string, content: string): Promise<void> {
    if (!absPath.startsWith('/') || absPath.includes("'")) throw new Error('invalid container path')
    await this.podman.ok(['exec', '-i', containerName(projectId), 'bash', '-c', `mkdir -p "$(dirname '${absPath}')" && cat > '${absPath}'`], { input: content })
  }

  stop(projectId: string): Promise<void> {
    return this.withLock(projectId, async () => {
      await this.podman.run(['stop', '-t', '10', containerName(projectId)], { timeoutMs: 60_000 })
      await this.refresh(projectId)
    })
  }

  /** Remove the container (project files and the OpenCode state volume are kept). */
  remove(projectId: string, alsoVolume = false): Promise<void> {
    return this.withLock(projectId, async () => {
      await this.podman.run(['rm', '-f', '-t', '5', containerName(projectId)], { timeoutMs: 60_000 })
      if (alsoVolume) await this.podman.run(['volume', 'rm', '-f', stateVolumeName(projectId)])
      this.passwords.delete(projectId)
      this.setStatus(projectId, { state: 'missing', opencodePort: null, novncPort: null, opencodeReady: false, cpuPct: null, memUsedMiB: null, memLimitMiB: null })
    })
  }

  /** Run a command inside the sandbox as the `dev` user, in /workspace. */
  exec(projectId: string, cmd: string[], opts: { input?: string; timeoutMs?: number; workdir?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
    const args = ['exec', '-i', '-w', opts.workdir ?? '/workspace']
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push('-e', `${k}=${v}`)
    args.push(containerName(projectId), ...cmd)
    return this.podman.run(args, { input: opts.input, timeoutMs: opts.timeoutMs ?? 600_000 })
  }

  /** Run a shell script inside the sandbox (bash -lc), throwing on failure. */
  async sh(projectId: string, script: string, timeoutMs = 600_000): Promise<string> {
    const r = await this.exec(projectId, ['bash', '-lc', script], { timeoutMs })
    if (r.code !== 0) throw new Error(`sandbox command failed (exit ${r.code}): ${script}\n${(r.stderr || r.stdout).trim().slice(-3000)}`)
    return r.stdout
  }

  /** CPU/RAM usage for all running LocalForge containers. */
  async pollStats(projectIds: string[]): Promise<void> {
    const running = projectIds.filter((id) => this.status(id).state === 'running')
    if (running.length === 0) return
    const r = await this.podman.run(['stats', '--no-stream', '--format', 'json', ...running.map(containerName)], { timeoutMs: 15_000 })
    if (r.code !== 0) return
    for (const s of parseStats(r.stdout)) {
      const id = running.find((pid) => containerName(pid) === s.name)
      if (id) this.setStatus(id, { cpuPct: s.cpuPct, memUsedMiB: Math.round(s.memUsedMiB), memLimitMiB: Math.round(s.memLimitMiB) })
    }
  }
}
