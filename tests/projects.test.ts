import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentsMd, GLOBAL_RULES, getTemplate, identOf, loadTemplates, scaffold, slugify, substitute, templateVars } from '../src/main/backend/templates'
import { folderNameOf, validateProjectName } from '../src/main/backend/projects'
import { changes, checkpointSubject, commitCheckpoint, listCheckpoints, parseLog, resetTo, shq } from '../src/main/backend/checkpoints'
import { listDir, readProjectFile, safeResolve } from '../src/main/backend/files'

const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), p))

describe('names', () => {
  it('slugs and identifiers', () => {
    expect(slugify('My Cool Game!')).toBe('my-cool-game')
    expect(identOf('My Cool Game!')).toBe('my_cool_game')
    expect(identOf('3d viewer')).toBe('app_3d_viewer')
    expect(folderNameOf(' My Game / v2 ')).toBe('My-Game-v2')
    expect(folderNameOf('../../etc')).toBe('etc')
    expect(validateProjectName('')).toMatch(/required/)
    expect(validateProjectName('ok-name')).toBeNull()
  })
  it('substitutes template variables', () => {
    const v = templateVars('My App', '')
    expect(substitute('{{name}}|{{slug}}|{{cident}}|{{pyident}}|{{description}}', v)).toBe('My App|my-app|my_app|my_app|Created with LocalForge.')
  })
})

describe('templates', () => {
  const ids = ['empty', 'cpp', 'react-ts', 'node', 'python', 'rust', 'electron'] as const
  it('ships all seven templates', () => {
    expect(loadTemplates().map((t) => t.id)).toEqual([...ids])
  })
  for (const id of ids) {
    it(`scaffolds ${id} with variables replaced and dotfiles renamed`, () => {
      const dir = tmp(`lf-tpl-${id}-`)
      const written = scaffold(id, dir, templateVars('Demo Thing', 'A demo.'))
      expect(written.length).toBeGreaterThan(0)
      expect(existsSync(path.join(dir, '.gitignore'))).toBe(true)
      expect(existsSync(path.join(dir, '_gitignore'))).toBe(false)
      expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('graphify-out/')
      for (const f of written) {
        if (/\.(png|jpg)$/.test(f)) continue
        expect(readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/\{\{(name|slug|cident|pyident|description)\}\}/)
        expect(f).not.toContain('{{')
      }
    })
  }
  it('names packages after the project', () => {
    const dir = tmp('lf-tpl-')
    scaffold('rust', dir, templateVars('Demo Thing', ''))
    expect(readFileSync(path.join(dir, 'Cargo.toml'), 'utf8')).toContain('name = "demo-thing"')
    const py = tmp('lf-tpl-')
    scaffold('python', py, templateVars('Demo Thing', ''))
    expect(existsSync(path.join(py, 'demo_thing', '__main__.py'))).toBe(true)
  })
  it('writes AGENTS.md with the global rules and template commands', () => {
    const md = agentsMd(getTemplate('cpp'), templateVars('Demo', 'Build a thing'))
    for (const r of GLOBAL_RULES) expect(md).toContain(r)
    expect(md).toContain('cmake --preset default && cmake --build --preset default')
    expect(md).toContain('ctest --preset default')
    expect(md).toContain('./build/demo')
    expect(md).toContain('computer_screenshot')
    expect(md).toContain('playwright_')
  })
})

/** Run checkpoint scripts against a temp repo by mapping /workspace to it. */
function localSh(dir: string) {
  return async (script: string) => execFileSync('bash', ['-c', script.replaceAll('/workspace', dir)], { encoding: 'utf8' })
}

describe('checkpoints (git, run against a real temp repo)', () => {
  it('commits, lists, diffs (incl. untracked) and resets', async () => {
    const dir = tmp('lf-git-')
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 't')
    git('config', 'user.email', 't@t')
    writeFileSync(path.join(dir, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-qm', 'Initial commit')
    const sh = localSh(dir)
    expect(await commitCheckpoint(sh, { subject: 'Checkpoint: nothing', sessionId: 's', messageId: 'm' })).toBeNull()

    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(path.join(dir, 'new.txt'), 'brand new\n')
    const ch = await changes(sh)
    expect(ch.baseSubject).toBe('Initial commit')
    expect(ch.files.map((f) => [f.path, f.status]).sort()).toEqual([
      ['a.txt', 'M'],
      ['new.txt', 'A'],
    ])
    expect(ch.diff).toContain('+two')
    expect(ch.diff).toContain('+brand new')
    // The real index is untouched (new.txt still untracked).
    expect(git('status', '--porcelain')).toContain('?? new.txt')

    const cp = await commitCheckpoint(sh, { subject: checkpointSubject("add 'two' and a new file"), sessionId: 'ses_1', messageId: 'msg_1' })
    expect(cp?.subject).toBe("Checkpoint: add 'two' and a new file")
    const list = await listCheckpoints(sh)
    expect(list.map((c) => c.subject)).toEqual(["Checkpoint: add 'two' and a new file", 'Initial commit'])
    expect(list[0]).toMatchObject({ sessionId: 'ses_1', messageId: 'msg_1' })

    writeFileSync(path.join(dir, 'later.txt'), 'later\n')
    await resetTo(sh, list[1].commit)
    expect(existsSync(path.join(dir, 'new.txt'))).toBe(false)
    expect(existsSync(path.join(dir, 'later.txt'))).toBe(false)
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n')
    await expect(resetTo(sh, 'HEAD; rm -rf /')).rejects.toThrow(/invalid/)
  })

  it('does not run repository hooks', async () => {
    const dir = tmp('lf-git-')
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 't')
    git('config', 'user.email', 't@t')
    writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch "$GIT_DIR/../HOOK_RAN"\nexit 1\n', { mode: 0o755 })
    writeFileSync(path.join(dir, 'f'), 'x')
    const cp = await commitCheckpoint(localSh(dir), { subject: 'Checkpoint: x', sessionId: 's', messageId: null })
    expect(cp).not.toBeNull()
    expect(existsSync(path.join(dir, 'HOOK_RAN'))).toBe(false)
  })

  it('parses git log records and quotes shell strings', () => {
    const recs = parseLog('abc\x1fab\x1fCheckpoint: x\x1f100\x1fLocalForge-Session: ses_1\nLocalForge-Message: msg_1\x1e\nroot\x1fro\x1fInitial\x1f50\x1f\x1e')
    expect(recs[0]).toMatchObject({ commit: 'abc', sessionId: 'ses_1', messageId: 'msg_1', time: 100000 })
    expect(recs[1].sessionId).toBeNull()
    expect(shq("it's")).toBe(`'it'\\''s'`)
  })
})

describe('project file access is confined to the project', () => {
  it('refuses paths and symlinks that escape', async () => {
    const root = tmp('lf-files-')
    mkdirSync(path.join(root, 'src'))
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export {}\n')
    writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0, 5]))
    symlinkSync('/etc/passwd', path.join(root, 'evil'))
    await expect(safeResolve(root, '../../etc/passwd')).rejects.toThrow()
    await expect(readProjectFile(root, 'evil')).rejects.toThrow(/outside/)
    expect((await readProjectFile(root, 'src/a.ts')).content).toBe('export {}\n')
    expect((await readProjectFile(root, 'bin.dat')).binary).toBe(true)
    const entries = await listDir(root, '')
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['src', 'dir'],
      ['bin.dat', 'file'],
      ['evil', 'symlink'],
    ])
  })
})
