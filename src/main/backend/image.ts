import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Podman } from './podman'
import type { ImageBuildState } from '../../shared/api'

export const IMAGE_REPO = 'localhost/localforge-sandbox'

/** Files that make up the build context (node_modules and dotfiles excluded). */
function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(path.join(dir, rel)).sort()) {
    if (name === 'node_modules' || name === '.containerignore') continue
    const r = path.join(rel, name)
    const st = statSync(path.join(dir, r))
    if (st.isDirectory()) out.push(...listFiles(dir, r))
    else out.push(r)
  }
  return out
}

/** Content hash of the sandbox build context -> image tag, so app updates rebuild the image. */
export function contextHash(dir: string): string {
  const h = createHash('sha256')
  for (const f of listFiles(dir)) {
    h.update(f + '\0')
    h.update(readFileSync(path.join(dir, f)))
    h.update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

/** Parse "STEP 12/28: RUN ..." into {step, total, text}. */
export function parseStepLine(line: string): { step: number; total: number; text: string } | null {
  const m = /^STEP (\d+)\/(\d+): (.*)$/.exec(line)
  if (!m) return null
  return { step: Number(m[1]), total: Number(m[2]), text: m[3] }
}

export class ImageManager extends EventEmitter<{ progress: [ImageBuildState] }> {
  private building: Promise<string> | null = null
  state: ImageBuildState = { status: 'unknown', tag: null, step: 0, totalSteps: 0, stepText: '', log: [], error: null }

  constructor(
    private readonly podman: Podman,
    private readonly contextDir: () => string,
  ) {
    super()
  }

  tag(): string {
    return `${IMAGE_REPO}:${contextHash(this.contextDir())}`
  }

  async check(): Promise<ImageBuildState> {
    const tag = this.tag()
    if (this.state.status === 'building') return this.state
    const exists = await this.podman.imageExists(tag)
    this.setState({ status: exists ? 'ready' : 'missing', tag })
    return this.state
  }

  /** Build the image if it's missing. Resolves to the image tag. Concurrent callers share one build. */
  ensure(): Promise<string> {
    if (this.building) return this.building
    this.building = (async () => {
      const tag = this.tag()
      if (await this.podman.imageExists(tag)) {
        this.setState({ status: 'ready', tag })
        return tag
      }
      return this.build(tag)
    })().finally(() => {
      this.building = null
    })
    return this.building
  }

  private async build(tag: string): Promise<string> {
    this.setState({ status: 'building', tag, step: 0, totalSteps: 0, stepText: 'Starting build', log: [], error: null })
    const log: string[] = []
    const { done } = this.podman.stream(['build', '--layers', '--pull=missing', '-t', tag, '-f', 'Containerfile', this.contextDir()], (line) => {
      log.push(line)
      if (log.length > 400) log.shift()
      const st = parseStepLine(line)
      if (st) this.setState({ step: st.step, totalSteps: st.total, stepText: st.text.slice(0, 160), log: log.slice(-60) })
      else this.throttledLog(log)
    })
    const code = await done
    if (code !== 0) {
      const error = `podman build failed (exit ${code}): ${log.slice(-15).join('\n')}`
      this.setState({ status: 'error', error, log: log.slice(-60) })
      throw new Error(error)
    }
    this.setState({ status: 'ready', step: this.state.totalSteps, stepText: 'Done', log: log.slice(-60) })
    return tag
  }

  private lastLogEmit = 0
  private throttledLog(log: string[]): void {
    const now = Date.now()
    if (now - this.lastLogEmit < 250) return
    this.lastLogEmit = now
    this.setState({ log: log.slice(-60) })
  }

  private setState(patch: Partial<ImageBuildState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('progress', this.state)
  }
}
