/**
 * Retry / edit a sent message: the conversation and the files go back to before that message,
 * then it is sent again.
 *   npx tsx e2e/rerun-e2e.ts [--dev]
 */
import { _electron as electron, type Page } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dev = process.argv.includes('--dev')
const outDir = path.resolve('e2e/output/rerun')
mkdirSync(outDir, { recursive: true })
const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = '') => {
  results.push([n, ok, d])
  console.log(ok ? 'PASS' : 'FAIL', n, d)
}
const app = dev
  ? await electron.launch({ args: [path.resolve('out/main/index.js')], env: { ...(process.env as Record<string, string>) } })
  : await electron.launch({ executablePath: path.join(os.homedir(), 'Applications', 'LocalForge.AppImage'), env: { ...(process.env as Record<string, string>), APPIMAGELAUNCHER_DISABLE: '1' } })
const page = await app.firstWindow()
page.on('dialog', (d) => void d.accept())
await page.setViewportSize({ width: 1480, height: 920 }).catch(() => {})
let projectId: string | null = null
let projectPath = ''

const call = (p: Page, m: string, ...a: unknown[]) =>
  p.evaluate(([m, a]) => (window as unknown as { lf: { call: (m: string, ...a: unknown[]) => Promise<unknown> } }).lf.call(m as string, ...(a as unknown[])), [m, a] as const)

async function waitTurn(re: RegExp): Promise<boolean> {
  const ok = await page
    .waitForFunction((src) => [...document.querySelectorAll('[data-testid="assistant-text"]')].some((e) => new RegExp(src).test(e.textContent ?? '')), re.source, { timeout: 20 * 60_000 })
    .then(() => true)
    .catch(() => false)
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 20 * 60_000 }).catch(() => {})
  await page.waitForTimeout(3000) // checkpoint commit on idle
  return ok
}
const userTexts = () => page.$$eval('[data-testid="user-message"]', (els) => els.map((e) => e.textContent?.trim() ?? ''))

try {
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 60_000 })
  const name = `rerun-${Date.now().toString(36).slice(-5)}`
  await page.click('[data-testid="new-project-button"]')
  await page.fill('[data-testid="project-name"]', name)
  await page.click('[data-testid="template-empty"]')
  await page.click('[data-testid="create-project-submit"]')
  await page.waitForSelector('[data-testid="create-progress"]', { state: 'detached', timeout: 20 * 60_000 })
  projectId = await page.getAttribute(`[data-testid="project-item"]:has-text("${name}")`, 'data-project-id')
  const proj = (await call(page, 'listProjects')) as Array<{ id: string; path: string }>
  projectPath = proj.find((p) => p.id === projectId)!.path
  await page.waitForSelector('[data-testid="composer-input"]:not([disabled])', { timeout: 180_000 })

  // Turn 1 creates a file.
  await page.fill('[data-testid="composer-input"]', 'Create the file note.txt containing the single word ALPHA, then reply with exactly: MADE')
  await page.keyboard.press('Enter')
  check('turn 1 finished', await waitTurn(/MADE/))
  check('turn 1 created note.txt', existsSync(path.join(projectPath, 'note.txt')))

  // Retry: same message runs again, still one user message.
  await page.hover('[data-testid="user-message"]')
  await page.click('[data-testid="retry-message"]')
  await page.waitForTimeout(4000)
  const afterRetry = await userTexts()
  check('retry keeps a single copy of the message', afterRetry.length === 1 && afterRetry[0].includes('ALPHA'), JSON.stringify(afterRetry))
  check('retried turn finished', await waitTurn(/MADE/))

  // Edit: different request; the file from the earlier answer is removed.
  await page.hover('[data-testid="user-message"]')
  await page.click('[data-testid="edit-message"]')
  await page.fill('[data-testid="edit-input"]', 'Do not use any tools. Reply with exactly: BRAVO')
  await page.screenshot({ path: path.join(outDir, 'editing.png') })
  await page.click('[data-testid="edit-send"]')
  await page.waitForTimeout(4000)
  check('edit put the files back (note.txt gone)', !existsSync(path.join(projectPath, 'note.txt')))
  check('edited turn finished', await waitTurn(/BRAVO/))
  const afterEdit = await userTexts()
  check('only the edited message is shown', afterEdit.length === 1 && afterEdit[0].includes('BRAVO') && !afterEdit[0].includes('ALPHA'), JSON.stringify(afterEdit))
  const old = await page.$$eval('[data-testid="assistant-text"]', (els) => els.some((e) => /MADE/.test(e.textContent ?? '')))
  check('the old answer is gone', !old)
  await page.screenshot({ path: path.join(outDir, 'after-edit.png') })
} catch (e) {
  check('no unexpected error', false, e instanceof Error ? e.message : String(e))
  await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {})
} finally {
  if (projectId) await call(page, 'removeProject', projectId, true).catch(() => {})
  await app.close().catch(() => {})
  const failed = results.filter((r) => !r[1])
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}
