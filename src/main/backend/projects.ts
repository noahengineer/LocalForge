import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CreateProgress, CreateStep, Project, TemplateId } from '../../shared/api'
import { slugify } from './templates'

const execFileP = promisify(execFile)

/** Registry of projects (~/.local/share/localforge/projects.json). */
export class ProjectStore {
  private projects: Project[] = []

  constructor(private readonly file: string) {
    try {
      this.projects = JSON.parse(readFileSync(file, 'utf8')) as Project[]
    } catch {
      this.projects = []
    }
  }

  list(): Project[] {
    return [...this.projects].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Project {
    const p = this.projects.find((x) => x.id === id)
    if (!p) throw new Error(`unknown project ${id}`)
    return p
  }

  find(id: string): Project | undefined {
    return this.projects.find((x) => x.id === id)
  }

  add(p: Project): void {
    this.projects.push(p)
    this.save()
  }

  update(id: string, patch: Partial<Project>): Project {
    const p = this.get(id)
    Object.assign(p, patch)
    this.save()
    return p
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.save()
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.projects, null, 2))
    renameSync(tmp, this.file)
  }
}

/** Folder name for a project: keep it readable but safe for shells and build tools. */
export function folderNameOf(name: string): string {
  const s = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
  return s || 'project'
}

export function validateProjectName(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Name is required'
  if (n.length > 64) return 'Name is too long (max 64 characters)'
  if (!/[A-Za-z0-9]/.test(n)) return 'Name must contain a letter or digit'
  return null
}

export function newProjectId(name: string): string {
  return `${slugify(name).slice(0, 24)}-${randomBytes(3).toString('hex')}`
}

export const CREATE_STEPS: Array<{ id: string; label: string }> = [
  { id: 'folder', label: 'Create project folder' },
  { id: 'scaffold', label: 'Scaffold template' },
  { id: 'agents', label: 'Write AGENTS.md' },
  { id: 'git', label: 'Initialize git' },
  { id: 'image', label: 'Prepare sandbox image' },
  { id: 'container', label: 'Create and start sandbox' },
  { id: 'opencode', label: 'Configure OpenCode (proxy, MCP, web search)' },
  { id: 'deps', label: 'Install dependencies' },
  { id: 'graphify', label: 'Install graphify and build the knowledge graph' },
  { id: 'commit', label: 'Initial commit' },
  { id: 'session', label: 'Open session' },
]

export const IMPORT_STEPS: Array<{ id: string; label: string }> = [
  { id: 'inspect', label: 'Check the folder' },
  { id: 'image', label: 'Prepare sandbox image' },
  { id: 'container', label: 'Create and start sandbox (folder mounted at /workspace)' },
  { id: 'opencode', label: 'Configure OpenCode (proxy, MCP, web search)' },
  { id: 'git', label: 'Set up git checkpoints' },
  { id: 'agents', label: 'Agent instructions' },
  { id: 'graphify', label: 'Build the knowledge graph' },
  { id: 'session', label: 'Open session' },
]

export class CreateTracker {
  progress: CreateProgress

  constructor(
    name: string,
    private readonly emit: (p: CreateProgress) => void,
    steps: Array<{ id: string; label: string }> = CREATE_STEPS,
  ) {
    this.progress = {
      name,
      steps: steps.map((s): CreateStep => ({ ...s, status: 'pending' })),
      done: false,
      error: null,
      projectId: null,
      sessionId: null,
    }
    this.emit(this.snapshot())
  }

  private snapshot(): CreateProgress {
    return structuredClone(this.progress)
  }

  set(id: string, status: CreateStep['status'], detail?: string): void {
    const s = this.progress.steps.find((x) => x.id === id)
    if (s) {
      s.status = status
      if (detail !== undefined) s.detail = detail
    }
    this.emit(this.snapshot())
  }

  async step<T>(id: string, fn: () => Promise<T>, detail?: string): Promise<T> {
    this.set(id, 'running', detail)
    try {
      const r = await fn()
      this.set(id, 'done')
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.set(id, 'error', msg.slice(0, 2000))
      throw e
    }
  }

  /** Like step(), but a failure is recorded and does not abort the whole operation. */
  async softStep<T>(id: string, fn: () => Promise<T>, detail?: string): Promise<T | null> {
    try {
      return await this.step(id, fn, detail)
    } catch {
      return null
    }
  }

  finish(patch: Partial<CreateProgress>): void {
    Object.assign(this.progress, patch, { done: true })
    this.emit(this.snapshot())
  }
}

/** Host git identity (used for the project's repo-local config), with a fallback. */
export async function hostGitIdentity(): Promise<{ name: string; email: string }> {
  const get = async (k: string) => {
    try {
      return (await execFileP('git', ['config', '--global', k])).stdout.trim()
    } catch {
      return ''
    }
  }
  return { name: (await get('user.name')) || 'LocalForge Agent', email: (await get('user.email')) || 'agent@localforge.local' }
}

/**
 * `git init` on the host. This is safe here because the repository is brand new: nothing in it
 * is agent-controlled yet. All later git operations run inside the sandbox.
 */
export async function gitInit(dir: string): Promise<void> {
  const id = await hostGitIdentity()
  const git = (...args: string[]) => execFileP('git', ['-C', dir, ...args])
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', id.name)
  await git('config', 'user.email', id.email)
}

export function ensureNewFolder(root: string, folder: string): string {
  const dir = path.join(root, folder)
  if (existsSync(dir)) throw new Error(`${dir} already exists`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function makeProject(input: { id: string; name: string; dir: string; template: TemplateId; description: string }): Project {
  return {
    id: input.id,
    name: input.name.trim(),
    path: input.dir,
    template: input.template,
    description: input.description.trim(),
    createdAt: Date.now(),
    lastSessionId: null,
  }
}
