/**
 * Focused UI checks: (1) scrolling up while the agent streams is not snapped back, and "Jump to
 * latest" resumes following; (2) Settings → Model lists downloaded models.
 *   npx tsx e2e/scroll-model-e2e.ts [--dev]
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dev = process.argv.includes('--dev')
const outDir = path.resolve('e2e/output/scroll-model')
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
const pos = () =>
  page.$eval('[data-testid="chat-scroll"]', (el) => ({ top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) }))
try {
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 60_000 })
  // Settings → Model
  await page.click('[data-testid="settings-button"]')
  await page.waitForSelector('[data-testid="model-picker"]', { timeout: 10_000 })
  await page.waitForTimeout(1500)
  const models = await page.$$eval('[data-testid="model-picker"] .font-mono', (els) => els.map((e) => e.textContent ?? ''))
  check('Settings shows the current model and downloaded models', models.length >= 2 && models.some((m) => m.includes('Qwen3.8-27B')), models.join(' | '))
  await page.screenshot({ path: path.join(outDir, 'model-picker.png') })
  await page.keyboard.press('Escape')

  // A project and a long streamed answer
  const name = `scroll-${Date.now().toString(36).slice(-5)}`
  await page.click('[data-testid="new-project-button"]')
  await page.fill('[data-testid="project-name"]', name)
  await page.click('[data-testid="template-empty"]')
  await page.click('[data-testid="create-project-submit"]')
  await page.waitForSelector('[data-testid="create-progress"]', { state: 'detached', timeout: 20 * 60_000 })
  projectId = await page.getAttribute(`[data-testid="project-item"]:has-text("${name}")`, 'data-project-id')
  await page.waitForSelector('[data-testid="composer-input"]:not([disabled])', { timeout: 180_000 })
  await page.fill('[data-testid="composer-input"]', 'Do not use any tools. Write 60 numbered lines, one short fact about blacksmithing per line.')
  await page.keyboard.press('Enter')
  // Wait until the answer is streaming and longer than the viewport.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="chat-scroll"]')!
      return !!document.querySelector('[data-testid="assistant-text"][data-streaming="true"]') && el.scrollHeight > el.clientHeight + 400
    },
    null,
    { timeout: 15 * 60_000 },
  )
  const before = await pos()
  check('follows the stream while at the bottom', before.gap < 10, JSON.stringify(before))
  const box = (await page.$('[data-testid="chat-scroll"]'))!
  await box.hover()
  await page.mouse.wheel(0, -60) // one small wheel tick up: this used to snap back
  await page.waitForTimeout(400)
  await page.mouse.wheel(0, -300)
  await page.waitForTimeout(4000) // the stream keeps growing meanwhile
  const after = await pos()
  check('scrolling up while streaming is not snapped back', after.gap > 250 && Math.abs(after.top - (before.top - 360)) < 40, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  check('"Jump to latest" appears', !!(await page.$('[data-testid="jump-to-latest"]')))
  await page.screenshot({ path: path.join(outDir, 'scrolled-up.png') })
  await page.click('[data-testid="jump-to-latest"]')
  await page.waitForTimeout(2500)
  const jumped = await pos()
  check('"Jump to latest" goes back to the bottom and keeps following', jumped.gap < 10 && !(await page.$('[data-testid="jump-to-latest"]')), JSON.stringify(jumped))
  await page.click('[data-testid="stop-button"]').catch(() => {})
} catch (e) {
  check('no unexpected error', false, e instanceof Error ? e.message : String(e))
  await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {})
} finally {
  if (projectId) await page.evaluate((id) => (window as unknown as { lf: { call: (m: string, ...a: unknown[]) => Promise<unknown> } }).lf.call('removeProject', id, true), projectId).catch(() => {})
  await app.close().catch(() => {})
  const failed = results.filter((r) => !r[1])
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}
