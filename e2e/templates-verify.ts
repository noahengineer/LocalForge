/**
 * Verifies that every project template builds, tests and runs out of the box inside its sandbox.
 * Creates one project per template through the Backend (no agent involved), runs the template's
 * build / test / run commands in the container, and removes the projects afterwards.
 *
 *   npx tsx e2e/templates-verify.ts [template ...] [--keep]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Backend } from '../src/main/backend/backend'
import { getTemplate, substitute, templateVars } from '../src/main/backend/templates'
import type { TemplateId } from '../src/shared/api'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const all: TemplateId[] = ['empty', 'cpp', 'react-ts', 'node', 'python', 'rust', 'electron']
const only = args.filter((a) => !a.startsWith('--')) as TemplateId[]
const ids = only.length ? only : all
const outDir = path.resolve('e2e/output/templates')
mkdirSync(outDir, { recursive: true })
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...a)

const backend = new Backend()
await backend.init({ hardware: false, polling: false })
const results: Array<{ template: string; step: string; ok: boolean; detail: string }> = []
const created: string[] = []

for (const id of ids) {
  const name = `tpl-${id}-${Date.now().toString(36).slice(-4)}`
  try {
    const r = await backend.createProject({ name, template: id, description: '' })
    created.push(r.projectId)
    log(`${id}: created ${r.projectId}`)
    const t = getTemplate(id)
    const vars = templateVars(name, '')
    // The run step for servers/GUIs is a short smoke check rather than a long-running process.
    const runCmd: Partial<Record<TemplateId, string>> = {
      node: 'PORT=3999 timeout 5 node src/server.js & sleep 2; curl -sf http://127.0.0.1:3999/health; wait',
      'react-ts': 'test -f dist/index.html && grep -q "<div id=\\"root\\">" dist/index.html && echo dist-ok',
      electron: 'timeout 15 npx electron --version',
      empty: 'git log --oneline | head -1',
    }
    const steps: Array<[string, string | undefined]> = [
      ['build', t.commands.build],
      ['test', t.commands.test],
      ['run', runCmd[id] ?? t.commands.run],
    ]
    for (const [step, cmd] of steps) {
      if (!cmd) continue
      const c = substitute(cmd, vars)
      const res = await backend.sandboxes.exec(r.projectId, ['bash', '-lc', c], { timeoutMs: 20 * 60_000 })
      const out = (res.stdout + res.stderr).trim().split('\n').slice(-4).join(' | ')
      results.push({ template: id, step, ok: res.code === 0, detail: `${c} -> exit ${res.code}: ${out.slice(0, 300)}` })
      log(`${id} ${step}: ${res.code === 0 ? 'OK' : 'FAIL'} (${c}) ${out.slice(0, 200)}`)
    }
  } catch (e) {
    results.push({ template: id, step: 'create', ok: false, detail: e instanceof Error ? e.message : String(e) })
    log(`${id}: FAILED`, e)
  }
}

if (!keep) for (const pid of created) await backend.removeProject(pid, true).catch(() => {})
await backend.shutdown()
writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} template steps passed`)
for (const f of failed) console.log('  FAILED:', f.template, f.step, f.detail)
process.exit(failed.length ? 1 : 0)
