import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DetectedStack, FolderInspection } from '../../shared/api'

/**
 * Importing an existing folder as a LocalForge project.
 *
 * The folder is bind-mounted into the sandbox as /workspace, so everything inside it becomes
 * readable and writable by the agent. checkImportPath() refuses folders whose exposure would
 * defeat the sandbox (the home folder itself, its parents, system folders, dotfolders such as
 * ~/.ssh), and inspection never runs git on the host (a repository that was previously
 * agent-controlled could carry hooks/config that execute code).
 */

const SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/dev', '/proc', '/sys', '/run', '/var', '/root', '/snap', '/srv']
const SENSITIVE_ENTRIES = ['.ssh', '.gnupg', '.password-store', '.aws', '.kube', '.docker']
const SKIP_COUNT = new Set(['node_modules', '.git', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__', 'vcpkg_installed', 'graphify-out'])

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')

/** Reasons a folder must not be mounted into a sandbox, or null if it is acceptable. */
export function checkImportPath(p: string, home = os.homedir()): string | null {
  if (!path.isAbsolute(p)) return 'Use an absolute path.'
  if (p.includes(':')) return 'Folders whose path contains ":" cannot be mounted by podman.'
  if (p === '/') return 'The root folder cannot be used as a project.'
  if (within(home, p)) return 'Your home folder (or a folder containing it) cannot be used: the agent would see all your files. Pick the project folder itself.'
  for (const d of SYSTEM_DIRS) if (within(p, d)) return `System folders (${d}) cannot be used as projects.`
  const rel = path.relative(home, p)
  if (!rel.startsWith('..') && rel.split(path.sep)[0]?.startsWith('.')) return `Hidden folders in your home (~/${rel.split(path.sep)[0]}) may hold keys and settings, so they cannot be used as projects.`
  return null
}

/** Count files (capped), skipping dependency/build folders. */
export function countFiles(dir: string, cap = 20000): number {
  let n = 0
  const walk = (d: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (n >= cap) return
      if (e.isDirectory()) {
        if (!SKIP_COUNT.has(e.name)) walk(path.join(d, e.name))
      } else if (e.isFile()) n++
    }
  }
  walk(dir)
  return n
}

export interface GitInfo {
  kind: 'none' | 'repo' | 'linked' | 'parent'
  branch: string | null
  head: string | null
  parentRepo: string | null
}

/** Read git state from the files in .git (no git process is run). */
export function readGitInfo(dir: string): GitInfo {
  const dotgit = path.join(dir, '.git')
  if (existsSync(dotgit)) {
    const st = lstatSync(dotgit)
    // A .git *file* (worktree / submodule) points at repository data outside the folder.
    if (!st.isDirectory()) return { kind: 'linked', branch: null, head: null, parentRepo: null }
    let branch: string | null = null
    let head: string | null = null
    try {
      const h = readFileSync(path.join(dotgit, 'HEAD'), 'utf8').trim()
      const m = /^ref: (refs\/heads\/(.+))$/.exec(h)
      if (m) {
        branch = m[2]
        const refFile = path.join(dotgit, m[1])
        if (existsSync(refFile)) head = readFileSync(refFile, 'utf8').trim()
        else {
          const packed = existsSync(path.join(dotgit, 'packed-refs')) ? readFileSync(path.join(dotgit, 'packed-refs'), 'utf8') : ''
          head = new RegExp(`^([0-9a-f]{40}) ${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(packed)?.[1] ?? null
        }
      } else if (/^[0-9a-f]{40}$/.test(h)) head = h
    } catch {
      /* unreadable */
    }
    return { kind: 'repo', branch, head, parentRepo: null }
  }
  for (let d = path.dirname(dir); d !== path.dirname(d); d = path.dirname(d)) {
    if (existsSync(path.join(d, '.git'))) return { kind: 'parent', branch: null, head: null, parentRepo: d }
  }
  return { kind: 'none', branch: null, head: null, parentRepo: null }
}

function readJson(f: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

/** Best-effort guess of the stack and its build/test/run commands (written as hints for the agent). */
export function detectStack(dir: string): DetectedStack {
  const has = (f: string) => existsSync(path.join(dir, f))
  const kinds: string[] = []
  const c: DetectedStack['commands'] = {}
  const notes: string[] = []
  const set = (k: keyof DetectedStack['commands'], v: string) => {
    if (!c[k]) c[k] = v
  }

  if (has('package.json')) {
    const pkg = readJson(path.join(dir, 'package.json')) ?? {}
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    kinds.push(deps.electron ? 'Electron (npm)' : deps.react ? 'React (npm)' : 'Node.js (npm)')
    set('setup', has('package-lock.json') ? 'npm ci' : 'npm install')
    if (scripts.build) set('build', 'npm run build')
    if (scripts.test && !/no test specified/.test(scripts.test)) set('test', 'npm test')
    if (scripts.start) set('run', deps.electron ? 'npm start -- --no-sandbox' : 'npm start')
    else if (scripts.dev) set('run', 'npm run dev')
    if (has('pnpm-lock.yaml') || has('yarn.lock') || has('bun.lockb')) notes.push('A pnpm/yarn/bun lockfile is present; install that tool in the sandbox if npm is not enough.')
    if (deps.electron) notes.push('Electron apps need --no-sandbox inside the container.')
  }
  if (has('CMakeLists.txt')) {
    kinds.push('C/C++ (CMake)')
    const tc = has('vcpkg.json') ? ' -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake' : ''
    set('build', has('CMakePresets.json') ? 'cmake --list-presets  # then: cmake --preset <name> && cmake --build --preset <name>' : `cmake -S . -B build -G Ninja${tc} && cmake --build build`)
    set('test', 'ctest --test-dir build --output-on-failure')
  }
  if (has('Cargo.toml')) {
    kinds.push('Rust (Cargo)')
    set('build', 'cargo build')
    set('test', 'cargo test')
    set('run', 'cargo run')
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    kinds.push('Python')
    set('setup', has('requirements.txt') ? 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt' : 'python3 -m venv .venv && .venv/bin/pip install -e .')
    const reqs = has('requirements.txt') ? readFileSync(path.join(dir, 'requirements.txt'), 'utf8') : ''
    const pyproject = has('pyproject.toml') ? readFileSync(path.join(dir, 'pyproject.toml'), 'utf8') : ''
    set('test', /pytest/.test(reqs + pyproject) ? '.venv/bin/python -m pytest' : '.venv/bin/python -m unittest discover')
    const mains = ['main.py', 'app.py', '__main__.py'].filter(has)
    if (mains.length) set('run', `.venv/bin/python ${mains[0]}`)
  } else {
    const py = safeList(dir).filter((f) => f.endsWith('.py'))
    if (py.length) {
      kinds.push('Python (scripts)')
      const main = py.find((f) => /^(main|app|run)\.py$/.test(f)) ?? py[0]
      set('run', `python3 ${main}`)
    }
  }
  if (has('Makefile') || has('makefile')) {
    kinds.push('Make')
    set('build', 'make')
    const mk = readFileSync(path.join(dir, has('Makefile') ? 'Makefile' : 'makefile'), 'utf8')
    if (/^test:/m.test(mk)) set('test', 'make test')
  }
  if (has('go.mod')) {
    kinds.push('Go')
    set('build', 'go build ./...')
    set('test', 'go test ./...')
    notes.push('Go is not preinstalled: sudo apt-get install -y golang-go')
  }
  if (safeList(dir).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
    kinds.push('.NET')
    notes.push('.NET is not preinstalled: sudo apt-get install -y dotnet-sdk-8.0')
  }
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    kinds.push('Java')
    notes.push('Java is not preinstalled: sudo apt-get install -y default-jdk (and maven/gradle)')
  }
  if (kinds.length === 0 && has('index.html')) {
    kinds.push('Static web page')
    set('run', 'python3 -m http.server 8000  # then open http://127.0.0.1:8000 with the browser tools')
  }
  return { kinds, commands: c, notes }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Everything the import dialog shows before anything is changed. */
export function inspectFolder(input: string, registered: Array<{ id: string; path: string }>, home = os.homedir()): FolderInspection {
  const raw = input.trim().replace(/^~(?=$|\/)/, home)
  const base: FolderInspection = {
    path: raw,
    ok: false,
    error: null,
    warnings: [],
    suggestedName: path.basename(raw) || 'project',
    git: { kind: 'none', branch: null, head: null, parentRepo: null },
    instructionsFile: null,
    stack: { kinds: [], commands: {}, notes: [] },
    fileCount: 0,
    existingProjectId: null,
  }
  if (!raw) return { ...base, error: 'Choose a folder.' }
  if (!path.isAbsolute(raw)) return { ...base, error: 'Use an absolute path (or ~/...).' }
  let real: string
  try {
    real = realpathSync(raw)
  } catch {
    return { ...base, error: 'Folder not found.' }
  }
  base.path = real
  base.suggestedName = path.basename(real)
  if (!statSync(real).isDirectory()) return { ...base, error: 'That is a file, not a folder.' }
  let realHome = home
  try {
    realHome = realpathSync(home)
  } catch {
    /* keep as given */
  }
  const refusal = checkImportPath(real, realHome)
  if (refusal) return { ...base, error: refusal }
  try {
    accessSync(real, constants.R_OK | constants.W_OK | constants.X_OK)
  } catch {
    return { ...base, error: 'You do not have write access to this folder.' }
  }
  const entries = safeList(real)
  const sensitive = SENSITIVE_ENTRIES.filter((e) => entries.includes(e))
  if (sensitive.length) return { ...base, error: `This folder contains ${sensitive.join(', ')} (keys or credentials). It looks like a home folder or backup and cannot be mounted into a sandbox.` }

  const existing = registered.find((p) => {
    try {
      return realpathSync(p.path) === real
    } catch {
      return false
    }
  })
  if (existing) return { ...base, error: 'This folder is already a LocalForge project.', existingProjectId: existing.id }
  for (const p of registered) {
    let rp: string
    try {
      rp = realpathSync(p.path)
    } catch {
      continue
    }
    if (within(real, rp)) base.warnings.push(`This folder is inside another LocalForge project (${p.path}).`)
    else if (within(rp, real)) base.warnings.push(`This folder contains another LocalForge project (${p.path}).`)
  }

  base.git = readGitInfo(real)
  if (base.git.kind === 'linked') base.warnings.push('This is a git worktree or submodule: its repository data lives outside the folder, so checkpoints are unavailable.')
  if (base.git.kind === 'parent') base.warnings.push(`This folder is inside the git repository ${base.git.parentRepo}. Only this folder is mounted, so that repository is not visible to the sandbox; enabling checkpoints creates a separate repository here.`)
  base.instructionsFile = (['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'] as const).find((f) => entries.includes(f)) ?? null
  base.stack = detectStack(real)
  base.fileCount = countFiles(real)
  if (base.fileCount >= 20000) base.warnings.push('Large folder (20,000+ files): building the knowledge graph may take a while.')
  if (entries.length === 0) base.warnings.push('The folder is empty.')
  return { ...base, ok: true }
}
