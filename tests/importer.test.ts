import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkImportPath, detectStack, inspectFolder, readGitInfo } from '../src/main/backend/importer'
import { selectCheckpoints } from '../src/main/backend/checkpoints'
import { importedAgentsMd, GLOBAL_RULES } from '../src/main/backend/templates'
import type { Checkpoint } from '../src/shared/api'

const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), p))
const HOME = '/home/alice'

describe('checkImportPath (what may be mounted into a sandbox)', () => {
  it('refuses the home folder, its parents, the root and system folders', () => {
    expect(checkImportPath('/', HOME)).toMatch(/root/)
    expect(checkImportPath(HOME, HOME)).toMatch(/home folder/)
    expect(checkImportPath('/home', HOME)).toMatch(/home folder/)
    expect(checkImportPath('/etc/nginx', HOME)).toMatch(/System/)
    expect(checkImportPath('/usr/local/src/x', HOME)).toMatch(/System/)
    expect(checkImportPath('/var/www', HOME)).toMatch(/System/)
  })
  it('refuses dotfolders in home (keys, settings)', () => {
    expect(checkImportPath(`${HOME}/.ssh`, HOME)).toMatch(/Hidden/)
    expect(checkImportPath(`${HOME}/.config/myapp`, HOME)).toMatch(/Hidden/)
  })
  it('refuses relative paths and paths podman cannot mount', () => {
    expect(checkImportPath('projects/x', HOME)).toMatch(/absolute/)
    expect(checkImportPath('/mnt/a:b', HOME)).toMatch(/":"/)
  })
  it('accepts normal project folders anywhere else', () => {
    expect(checkImportPath(`${HOME}/code/old-tool`, HOME)).toBeNull()
    expect(checkImportPath(`${HOME}/AIProjects/x`, HOME)).toBeNull()
    expect(checkImportPath('/mnt/Dev-Gaming/Dev/thing', HOME)).toBeNull()
    expect(checkImportPath('/tmp/scratch/app', HOME)).toBeNull()
    expect(checkImportPath(`${HOME}/projects/.hidden-inside-ok`, HOME)).toBeNull()
  })
})

describe('readGitInfo (no git process is run)', () => {
  it('reads branch and HEAD from .git, including packed refs', () => {
    const d = tmp('lf-git-')
    execFileSync('git', ['-C', d, 'init', '-q', '-b', 'trunk'])
    execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'])
    const head = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(readGitInfo(d)).toEqual({ kind: 'repo', branch: 'trunk', head, parentRepo: null })
    execFileSync('git', ['-C', d, 'pack-refs', '--all'])
    expect(readGitInfo(d).head).toBe(head)
  })
  it('detects worktree/submodule .git files and parent repositories', () => {
    const d = tmp('lf-git-')
    writeFileSync(path.join(d, '.git'), 'gitdir: /elsewhere\n')
    expect(readGitInfo(d).kind).toBe('linked')
    const parent = tmp('lf-git-')
    execFileSync('git', ['-C', parent, 'init', '-q'])
    mkdirSync(path.join(parent, 'sub'))
    expect(readGitInfo(path.join(parent, 'sub'))).toMatchObject({ kind: 'parent', parentRepo: parent })
    expect(readGitInfo(tmp('lf-nogit-')).kind).toBe('none')
  })
})

describe('detectStack', () => {
  it('reads npm scripts', () => {
    const d = tmp('lf-stack-')
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest', start: 'node .' }, dependencies: { react: '1' } }))
    writeFileSync(path.join(d, 'package-lock.json'), '{}')
    expect(detectStack(d)).toMatchObject({ kinds: ['React (npm)'], commands: { setup: 'npm ci', build: 'npm run build', test: 'npm test', run: 'npm start' } })
  })
  it('ignores the npm placeholder test script', () => {
    const d = tmp('lf-stack-')
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
    expect(detectStack(d).commands.test).toBeUndefined()
  })
  it('detects CMake (+vcpkg), Cargo, Python, loose scripts and Make', () => {
    const c = tmp('lf-stack-')
    writeFileSync(path.join(c, 'CMakeLists.txt'), '')
    writeFileSync(path.join(c, 'vcpkg.json'), '{}')
    expect(detectStack(c).commands.build).toContain('vcpkg.cmake')
    const r = tmp('lf-stack-')
    writeFileSync(path.join(r, 'Cargo.toml'), '')
    expect(detectStack(r).commands).toEqual({ build: 'cargo build', test: 'cargo test', run: 'cargo run' })
    const p = tmp('lf-stack-')
    writeFileSync(path.join(p, 'requirements.txt'), 'pytest\nrequests\n')
    writeFileSync(path.join(p, 'main.py'), '')
    expect(detectStack(p).commands).toMatchObject({ test: '.venv/bin/python -m pytest', run: '.venv/bin/python main.py' })
    const s = tmp('lf-stack-')
    writeFileSync(path.join(s, 'tool.py'), '')
    expect(detectStack(s)).toMatchObject({ kinds: ['Python (scripts)'], commands: { run: 'python3 tool.py' } })
    const m = tmp('lf-stack-')
    writeFileSync(path.join(m, 'Makefile'), 'all:\n\tcc x.c\ntest:\n\t./t\n')
    expect(detectStack(m).commands).toMatchObject({ build: 'make', test: 'make test' })
    expect(detectStack(tmp('lf-stack-')).kinds).toEqual([])
  })
})

describe('inspectFolder', () => {
  it('describes an acceptable folder', () => {
    const d = tmp('lf-insp-')
    writeFileSync(path.join(d, 'CLAUDE.md'), '# my rules')
    writeFileSync(path.join(d, 'app.py'), 'print(1)')
    const r = inspectFolder(d, [], '/nonexistent-home')
    expect(r.ok).toBe(true)
    expect(r.instructionsFile).toBe('CLAUDE.md')
    expect(r.git.kind).toBe('none')
    expect(r.fileCount).toBe(2)
    expect(r.suggestedName).toBe(path.basename(d))
  })
  it('refuses folders containing keys, missing folders and already-imported folders', () => {
    const d = tmp('lf-insp-')
    mkdirSync(path.join(d, '.ssh'))
    expect(inspectFolder(d, [], '/nonexistent-home').error).toMatch(/\.ssh/)
    expect(inspectFolder('/definitely/not/here', [], '/nonexistent-home').error).toMatch(/not found/)
    const e = tmp('lf-insp-')
    const r = inspectFolder(e, [{ id: 'p1', path: e }], '/nonexistent-home')
    expect(r.ok).toBe(false)
    expect(r.existingProjectId).toBe('p1')
  })
  it('refuses the home folder itself', () => {
    const home = tmp('lf-home-')
    expect(inspectFolder(home, [], home).error).toMatch(/home folder/)
  })
})

describe('checkpoints of imported repositories', () => {
  const cp = (commit: string, sessionId: string | null): Checkpoint => ({ commit, shortCommit: commit.slice(0, 7), subject: commit, time: 0, sessionId, messageId: null })
  it('stops at the base commit and never offers older history', () => {
    const log = [cp('c3', 's'), cp('userwork', null), cp('c2', 's'), cp('base', null), cp('olduser1', null), cp('olduser0', null)]
    expect(selectCheckpoints(log, 'base').map((c) => c.commit)).toEqual(['c3', 'c2', 'base'])
  })
  it('without a reachable base only offers LocalForge checkpoints', () => {
    expect(selectCheckpoints([cp('c1', 's'), cp('x', null)], 'gone').map((c) => c.commit)).toEqual(['c1'])
    expect(selectCheckpoints([cp('c1', 's'), cp('x', null)], null).map((c) => c.commit)).toEqual(['c1'])
  })
  it('legacy projects (no base recorded) keep the root commit', () => {
    expect(selectCheckpoints([cp('c1', 's'), cp('mid', null), cp('root', null)]).map((c) => c.commit)).toEqual(['c1', 'root'])
  })
})

describe('importedAgentsMd', () => {
  it('includes the rules, detected commands and defers to the project file', () => {
    const md = importedAgentsMd({
      name: 'Old Tool',
      description: '',
      stack: { kinds: ['Rust (Cargo)'], commands: { build: 'cargo build' }, notes: ['note one'] },
      ownInstructionsFile: 'CLAUDE.md',
      graph: false,
      checkpoints: true,
    })
    for (const r of GLOBAL_RULES) expect(md).toContain(r)
    expect(md).toContain('`cargo build`')
    expect(md).toContain('CLAUDE.md')
    expect(md).toContain('note one')
    expect(md).not.toContain('graphify query')
    expect(md).toContain('explore it')
  })
})
