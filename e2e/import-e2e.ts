/**
 * "Open existing folder" end-to-end test, driven through the real app UI (Playwright-for-Electron).
 *
 *   npx tsx e2e/import-e2e.ts [--dev] [--app <AppImage>] [--keep]
 *
 * Fixture A (old-ai-tool): a non-git folder with a Python program and its own CLAUDE.md.
 * Fixture B (legacy-web):  a git repo with history, an uncommitted edit and an untracked file.
 * Checks that importing is in place and non-destructive, git/instructions handling is right, the
 * agent works on the folder (and still follows the project's own CLAUDE.md), Undo cannot reach the
 * repository's older history, dangerous folders are refused, and removing never deletes the folder.
 */
import { _electron as electron, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const dev = args.includes('--dev')
const keep = args.includes('--keep')
const appPath = args.includes('--app') ? args[args.indexOf('--app') + 1] : path.join(os.homedir(), 'Applications', 'LocalForge.AppImage')
const outDir = path.resolve('e2e/output/import')
const fixtures = path.join(outDir, 'fixtures')
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a)
const results: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail })
  log(ok ? 'PASS' : 'FAIL', name, detail ? `| ${detail}` : '')
}
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...a], { encoding: 'utf8' }).trim()
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
function hashTree(dir: string, skip = new Set(['.git', 'graphify-out', 'AGENTS.md', '.playwright-mcp'])): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const n of readdirSync(path.join(dir, rel))) {
      if (skip.has(n)) continue
      const r = path.join(rel, n)
      if (statSync(path.join(dir, r)).isDirectory()) walk(r)
      else out[r] = sha(path.join(dir, r))
    }
  }
  walk('')
  return out
}

// --- Fixtures ---------------------------------------------------------------------------------------
rmSync(fixtures, { recursive: true, force: true })
const A = path.join(fixtures, 'old-ai-tool')
mkdirSync(path.join(A, '__pycache__'), { recursive: true })
writeFileSync(path.join(A, 'CLAUDE.md'), '# Notes from the AI that wrote this tool\n\n- Use python3.\n- IMPORTANT: always end every reply to the user with the single word CHEERIO.\n')
writeFileSync(
  path.join(A, 'converter.py'),
  'def km_to_miles(km):\n    return km * 0.621371\n\nif __name__ == "__main__":\n    print(f"42 km = {km_to_miles(42):.2f} miles")\n',
)
writeFileSync(path.join(A, '__pycache__', 'converter.cpython-312.pyc'), Buffer.from([1, 2, 3]))
const B = path.join(fixtures, 'legacy-web')
mkdirSync(B, { recursive: true })
git(B, 'init', '-q', '-b', 'main')
writeFileSync(path.join(B, 'package.json'), JSON.stringify({ name: 'legacy-web', scripts: { test: 'node test.js', start: 'node server.js' } }, null, 2))
writeFileSync(path.join(B, 'server.js'), 'console.log("v1")\n')
writeFileSync(path.join(B, 'test.js'), 'console.log("ok")\n')
git(B, 'add', '-A')
git(B, '-c', 'user.name=Old', '-c', 'user.email=old@x', 'commit', '-q', '-m', 'first')
writeFileSync(path.join(B, 'server.js'), 'console.log("v2")\n')
git(B, '-c', 'user.name=Old', '-c', 'user.email=old@x', 'commit', '-q', '-am', 'second')
const oldHistory = git(B, 'log', '--format=%H %s')
writeFileSync(path.join(B, 'server.js'), 'console.log("v3 work in progress")\n') // uncommitted edit
writeFileSync(path.join(B, 'notes.txt'), 'untracked notes\n') // untracked file
const hashA = hashTree(A)
const hashB = hashTree(B)

// --- App ------------------------------------------------------------------------------------------
const app = dev
  ? await electron.launch({ args: [path.resolve('out/main/index.js')], env: { ...(process.env as Record<string, string>) } })
  : await electron.launch({ executablePath: appPath, env: { ...(process.env as Record<string, string>), APPIMAGELAUNCHER_DISABLE: '1' } })
const page: Page = await app.firstWindow()
page.on('dialog', (d) => void d.accept())
page.on('pageerror', (e) => log('[pageerror]', e.message))
await page.setViewportSize({ width: 1480, height: 920 }).catch(() => {})
const shot = (n: string) => page.screenshot({ path: path.join(outDir, `${n}.png`) })
const call = (m: string, ...a: unknown[]) => page.evaluate(([mm, aa]) => (window as unknown as { lf: { call: (m: string, ...a: unknown[]) => Promise<unknown> } }).lf.call(mm as string, ...(aa as unknown[])), [m, a] as const)
const ids: string[] = []

async function importViaUi(folder: string, label: string): Promise<{ id: string | null; info: Record<string, string> }> {
  await page.click('[data-testid="open-folder-button"]')
  await page.fill('[data-testid="import-path"]', folder)
  await page.waitForSelector('[data-testid="inspection-card"][data-ok="true"]', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await shot(`${label}-1-inspection`)
  const info = {
    stack: await page.innerText('[data-testid="inspection-stack"]'),
    git: await page.innerText('[data-testid="inspection-git"]'),
    instructions: await page.innerText('[data-testid="inspection-instructions"]'),
    name: await page.inputValue('[data-testid="import-name"]'),
  }
  log(label, 'inspection', JSON.stringify(info))
  await page.click('[data-testid="import-submit"]')
  await page.waitForSelector('[data-testid="create-progress"]', { timeout: 10_000 })
  await page.waitForTimeout(1500)
  await shot(`${label}-2-progress`)
  const done = await page
    .waitForSelector('[data-testid="create-progress"]', { state: 'detached', timeout: 20 * 60_000 })
    .then(() => true)
    .catch(() => false)
  check(`${label}: imported via the dialog`, done)
  const id = await page.getAttribute(`[data-testid="project-item"]:has-text("${info.name}")`, 'data-project-id').catch(() => null)
  if (id) ids.push(id)
  await page.waitForSelector('[data-testid="composer-input"]:not([disabled])', { timeout: 180_000 }).catch(() => {})
  return { id, info }
}

async function askAndWait(text: string): Promise<string> {
  const before = (await page.$$('[data-testid="assistant-text"]')).length
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="stop-button"]', { timeout: 30_000 }).catch(() => {})
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 20 * 60_000 })
  await page.waitForTimeout(1500)
  const texts = await page.$$eval('[data-testid="assistant-text"]', (els) => els.map((e) => e.textContent ?? ''))
  return texts.slice(before).join('\n')
}

try {
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 60_000 })

  // Refusals: the home folder cannot be mounted into a sandbox.
  await page.click('[data-testid="open-folder-button"]')
  await page.fill('[data-testid="import-path"]', os.homedir())
  await page.waitForSelector('[data-testid="inspection-card"][data-ok="false"]', { timeout: 15_000 })
  const refusal = await page.innerText('[data-testid="inspection-card"]')
  check('home folder is refused', /home folder/i.test(refusal) && (await page.isDisabled('[data-testid="import-submit"]')), refusal)
  await shot('0-refused-home')
  await page.keyboard.press('Escape')

  // --- Fixture A: non-git folder with its own CLAUDE.md --------------------------------------------
  const { id: idA, info: infoA } = await importViaUi(A, 'A')
  check('A: inspection detected Python, no git, existing CLAUDE.md', infoA.stack.includes('Python') && /Not a git repository/.test(infoA.git) && infoA.instructions.includes('CLAUDE.md') && infoA.name === 'old-ai-tool', JSON.stringify(infoA))
  check('A: project files untouched by the import', JSON.stringify(hashTree(A)) === JSON.stringify(hashA))
  check('A: CLAUDE.md kept, no AGENTS.md added to the folder', existsSync(path.join(A, 'CLAUDE.md')) && !existsSync(path.join(A, 'AGENTS.md')))
  const aLog = git(A, 'log', '--format=%s')
  check('A: git initialized with one commit of the current files', aLog === 'Initial commit (imported into LocalForge)', aLog)
  check('A: __pycache__ and graphify-out kept out of git (local exclude)', !git(A, 'ls-files').includes('__pycache__') && git(A, 'status', '--porcelain') === '' && readFileSync(path.join(A, '.git/info/exclude'), 'utf8').includes('graphify-out/'), git(A, 'status', '--porcelain'))
  const answerA = await askAndWait('What does converter.py do? Run it with python3 and tell me its exact output.')
  log('A answer:', answerA.replace(/\s+/g, ' ').slice(0, 300))
  check('A: agent ran the existing program in the sandbox', answerA.includes('26.10'), answerA.slice(0, 200))
  check("A: the project's own CLAUDE.md still applies (reply ends with CHEERIO)", /CHEERIO/.test(answerA))
  await shot('A-3-answer')
  const rulesInSandbox = idA
    ? ((await call('sandboxStatus', idA)) as { container: string }).container
    : null
  if (rulesInSandbox) {
    const settings = JSON.parse(readFileSync(path.join(os.homedir(), '.config/LocalForge/settings.json'), 'utf8'))
    const root = settings.sandbox?.podmanRoot
    const podmanArgs = root ? ['--root', path.join(root, 'storage'), '--runroot', path.join(process.env.XDG_RUNTIME_DIR ?? '/run/user/1000', 'localforge-containers')] : []
    const rules = execFileSync('podman', [...podmanArgs, 'exec', rulesInSandbox, 'cat', '/home/dev/.config/opencode/AGENTS.md'], { encoding: 'utf8' })
    check("A: LocalForge's rules are given to the agent inside the sandbox", rules.includes('Always read a file before editing it') && rules.includes('CLAUDE.md'))
  }

  // --- Fixture B: git repo with history and uncommitted work ---------------------------------------
  const { info: infoB } = await importViaUi(B, 'B')
  check('B: inspection detected the git repo and npm', /branch main/.test(infoB.git) && infoB.stack.includes('npm') && /No AGENTS\.md/.test(infoB.instructions), JSON.stringify(infoB))
  const bLog = git(B, 'log', '--format=%H %s').split('\n')
  const old = oldHistory.split('\n')
  check('B: existing history kept unchanged', JSON.stringify(bLog.slice(-old.length)) === JSON.stringify(old), `${bLog.length} commits`)
  check('B: uncommitted work snapshotted, then AGENTS.md added', bLog[1]?.endsWith('LocalForge: snapshot of uncommitted changes at import') && bLog[0]?.endsWith('Add AGENTS.md (LocalForge)'), bLog.slice(0, 2).join(' | '))
  const snapFiles = git(B, 'show', '--name-only', '--format=', 'HEAD~1').split('\n').sort()
  check('B: snapshot holds exactly the uncommitted edit and the untracked file', JSON.stringify(snapFiles) === JSON.stringify(['notes.txt', 'server.js']), snapFiles.join(','))
  check('B: working files unchanged by the import', JSON.stringify(hashTree(B)) === JSON.stringify(hashB))
  const agents = readFileSync(path.join(B, 'AGENTS.md'), 'utf8')
  check('B: AGENTS.md lists the detected commands', agents.includes('`npm test`') && agents.includes('Node.js (npm)'))
  await page.click('[data-testid="tab-changes"]')
  await page.waitForTimeout(5000)
  const cps = await page.$$eval('[data-testid="checkpoint-item"]', (els) => els.map((e) => e.textContent ?? ''))
  check('B: Undo only offers checkpoints from the import on (never the old history)', cps.length === 1 && cps[0].includes('Add AGENTS.md'), cps.join(' | '))
  await shot('B-3-changes')

  // Removing imported projects never deletes their folders.
  for (const id of [...ids]) await call('removeProject', id, true)
  check('removing imported projects keeps the folders', existsSync(path.join(A, 'converter.py')) && existsSync(path.join(B, 'server.js')))
  ids.length = 0
} catch (e) {
  check('no unexpected error', false, e instanceof Error ? e.stack : String(e))
  await shot('99-error').catch(() => {})
} finally {
  if (!keep) for (const id of ids) await call('removeProject', id, false).catch(() => {})
  await app.close().catch(() => {})
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  for (const f of failed) console.log('  FAILED:', f.name, f.detail ?? '')
  process.exit(failed.length ? 1 : 0)
}
