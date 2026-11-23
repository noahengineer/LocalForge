/**
 * Layout checks in an isolated instance, so they can run next to a LocalForge that is in use:
 * own config/data/userData dirs, stats proxy on 18081, one throwaway project, and a fake `podman`
 * that always fails, so no container is started.
 *   npx electron-vite build && npx tsx e2e/layout-e2e.ts
 * Covers: resizing and collapsing the sidebar / right panel (remembered after restart), the
 * composer's model and effort pills (no wrapping, also in Plan mode at a narrow width).
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const iso = mkdtempSync(path.join(os.tmpdir(), 'lf-layout-'))
for (const d of ['cfg/LocalForge', 'data', 'fakebin', 'proj']) mkdirSync(path.join(iso, d), { recursive: true })
writeFileSync(path.join(iso, 'cfg/LocalForge/settings.json'), JSON.stringify({ proxy: { port: 18081 } }))
writeFileSync(path.join(iso, 'fakebin/podman'), '#!/bin/sh\necho "podman disabled for layout test" >&2\nexit 125\n')
chmodSync(path.join(iso, 'fakebin/podman'), 0o755)
writeFileSync(
  path.join(iso, 'data/projects.json'),
  JSON.stringify([{ id: 'layout-test-0001', name: 'Layout test', path: path.join(iso, 'proj'), template: 'empty', description: '', createdAt: Date.now(), checkpoints: false }]),
)
const outDir = path.resolve('e2e/output/layout')
mkdirSync(outDir, { recursive: true })
const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = '') => {
  results.push([n, ok, d])
  console.log(ok ? 'PASS' : 'FAIL', n, d)
}
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.resolve('out/main/index.js'), `--user-data-dir=${iso}/ud`],
    env: { ...(process.env as Record<string, string>), PATH: `${iso}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: `${iso}/cfg`, LOCALFORGE_DATA_DIR: `${iso}/data` },
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1480, height: 900 }).catch(() => {})
  await page.waitForSelector('[data-testid="topbar"]', { timeout: 60_000 })
  return { app, page }
}
const box = async (p: Page, sel: string) => (await p.locator(sel).boundingBox())!
async function drag(p: Page, sel: string, dx: number) {
  const b = await box(p, sel)
  const x = b.x + b.width / 2
  const y = b.y + 300
  await p.mouse.move(x, y)
  await p.mouse.down()
  for (let i = 1; i <= 10; i++) await p.mouse.move(x + (dx * i) / 10, y)
  await p.mouse.up()
  await p.waitForTimeout(200)
}

let { app, page } = await launch()
try {
  const sw0 = (await box(page, '[data-testid="sidebar"]')).width
  const rw0 = (await box(page, '[data-testid="right-panel"]')).width
  await drag(page, '[data-testid="sidebar-resize"]', 100)
  const sw1 = (await box(page, '[data-testid="sidebar"]')).width
  check('sidebar widens when dragged', Math.abs(sw1 - (sw0 + 100)) <= 3, `${sw0} -> ${sw1}`)
  await drag(page, '[data-testid="right-resize"]', -150)
  const rw1 = (await box(page, '[data-testid="right-panel"]')).width
  // Capped so the chat keeps >= 380px: window - sidebar - 380.
  const cap = 1480 - sw1 - 380
  check('right panel widens when dragged (up to the cap that keeps the chat usable)', Math.abs(rw1 - Math.min(rw0 + 150, cap)) <= 3, `${rw0} -> ${rw1} (cap ${cap})`)
  await drag(page, '[data-testid="right-resize"]', 560)
  check('dragging the right panel far collapses it', (await page.locator('[data-testid="right-panel"]').count()) === 0)
  await page.click('button[title="Toggle side panel"]')
  const rw2 = (await box(page, '[data-testid="right-panel"]')).width
  check('reopened right panel has its width from before the collapse', Math.abs(rw2 - rw1) <= 3, `${rw2}`)
  {
    const b = await box(page, '[data-testid="sidebar-resize"]')
    await page.mouse.dblclick(b.x + b.width / 2, b.y + 300)
  }
  check('double-click collapses the sidebar', (await page.locator('[data-testid="sidebar"]').count()) === 0)
  await page.screenshot({ path: path.join(outDir, 'sidebar-collapsed.png') })
  await page.click('[data-testid="sidebar-open"]')
  check('sidebar comes back with its width', Math.abs((await box(page, '[data-testid="sidebar"]')).width - sw1) <= 3)
  await page.click('[data-testid="sidebar-close"]')
  await app.close()
  await new Promise((r) => setTimeout(r, 2500))
  ;({ app, page } = await launch())
} catch (e) {
  check('no unexpected error (part 1)', false, String(e))
}
try {
  // After a restart: sidebar stays collapsed, right panel width remembered.
  check('collapsed sidebar is remembered after restart', (await page.locator('[data-testid="sidebar"]').count()) === 0)
  await page.click('[data-testid="sidebar-open"]')
  await page.click('[data-testid="project-item"]')
  await page.waitForSelector('[data-testid="mode-toggle"]', { timeout: 20_000 })
  for (const width of [1480, 1100]) {
    await page.setViewportSize({ width, height: 900 })
    for (const mode of ['build', 'plan']) {
      if ((await page.getAttribute('[data-testid="mode-toggle"]', 'data-mode')) !== mode) await page.click('[data-testid="mode-toggle"]')
      await page.waitForTimeout(300)
      const h = await Promise.all(['mode-toggle', 'model-pill', 'effort-pill'].map(async (id) => Math.round((await box(page, `[data-testid="${id}"]`)).height)))
      const mp = await box(page, '[data-testid="model-pill"]')
      check(`model pill keeps some of its name (${mode}, ${width}px)`, mp.width >= 76, `${Math.round(mp.width)}px`)
      const send = await box(page, '[data-testid="send-button"]')
      const inputBox = await page.evaluate(() => document.querySelector('[data-testid="composer-input"]')!.parentElement!.getBoundingClientRect().right)
      check(`send button stays inside the message box (${mode}, ${width}px)`, send.x + send.width <= inputBox + 1, `${Math.round(send.x + send.width)} <= ${Math.round(inputBox)}`)
      check(`toolbar buttons stay on one line (${mode}, ${width}px)`, h.every((x) => x <= 30), h.join('/'))
      const chatW = Math.round((await box(page, '[data-testid="chat-scroll"]')).width)
      check(`chat keeps >= 380px at ${width}px (${mode})`, chatW >= 378, `${chatW}px`)
    }
  }
  await page.screenshot({ path: path.join(outDir, 'composer-plan-narrow.png') })
  await page.setViewportSize({ width: 1480, height: 900 })
  await page.click('[data-testid="model-pill"]')
  await page.waitForSelector('[data-testid="model-popover"]')
  await page.waitForTimeout(1500)
  const rows = await page.locator('[data-testid="model-popover"] button').allTextContents()
  const pop = await box(page, '[data-testid="model-popover"]')
  const topEl = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="model-popover"]') !== null, [pop.x + pop.width - 20, pop.y + 20])
  check('model popover is on top and inside the window', topEl && pop.x >= 0 && pop.x + pop.width <= 1480, JSON.stringify(pop))
  check('model popover lists downloaded models', rows.some((r) => r.includes('Qwen3.8-27B')), rows.join(' | '))
  await page.screenshot({ path: path.join(outDir, 'model-popover.png') })
  await page.keyboard.press('Escape')
  await page.click('[data-testid="effort-pill"]')
  await page.waitForSelector('[data-testid="effort-popover"]')
  await page.screenshot({ path: path.join(outDir, 'effort-popover.png') })
} catch (e) {
  check('no unexpected error (part 2)', false, String(e).split('\n').slice(0, 8).join(' | '))
  await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
  const failed = results.filter((r) => !r[1])
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}
