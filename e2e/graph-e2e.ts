/**
 * Map tab: shows a project's graphify-out/graph.html through lf-graph:// with the bundled
 * vis-network (no internet), in a sandboxed frame; a symlinked graph.html pointing outside the
 * project is refused. Runs in an isolated instance (own dirs, fake failing podman), so it can run
 * next to a LocalForge in use.
 *   npx electron-vite build && GRAPH_HTML=/path/to/graph.html npx tsx e2e/graph-e2e.ts
 */
import { _electron as electron } from 'playwright'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const iso = mkdtempSync(path.join(os.tmpdir(), 'lf-graph-'))
const proj = path.join(iso, 'proj')
for (const d of ['cfg/LocalForge', 'data', 'fakebin', 'proj/graphify-out']) mkdirSync(path.join(iso, d), { recursive: true })
writeFileSync(path.join(iso, 'cfg/LocalForge/settings.json'), JSON.stringify({ proxy: { port: 18082 } }))
writeFileSync(path.join(iso, 'fakebin/podman'), '#!/bin/sh\nexit 125\n')
chmodSync(path.join(iso, 'fakebin/podman'), 0o755)
writeFileSync(path.join(iso, 'data/projects.json'), JSON.stringify([{ id: 'graph-test-0001', name: 'Graph test', path: proj, template: 'empty', description: '', createdAt: Date.now(), checkpoints: false }]))
copyFileSync(process.env.GRAPH_HTML!, path.join(proj, 'graphify-out/graph.html'))

const outDir = path.resolve('e2e/output/graph')
mkdirSync(outDir, { recursive: true })
const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = '') => {
  results.push([n, ok, d])
  console.log(ok ? 'PASS' : 'FAIL', n, d)
}
// APPIMAGE=1 tests the installed ~/Applications/LocalForge.AppImage instead of the dev build.
const packaged = !!process.env.APPIMAGE
const app = await electron.launch({
  ...(packaged ? { executablePath: path.join(os.homedir(), 'Applications', 'LocalForge.AppImage') } : {}),
  args: [...(packaged ? [] : [path.resolve('out/main/index.js')]), `--user-data-dir=${iso}/ud`],
  env: { ...(process.env as Record<string, string>), APPIMAGELAUNCHER_DISABLE: '1', PATH: `${iso}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: `${iso}/cfg`, LOCALFORGE_DATA_DIR: `${iso}/data` },
})
const page = await app.firstWindow()
const external: string[] = []
page.context().on('request', (r) => {
  if (/^https?:/.test(r.url()) && !/127\.0\.0\.1|localhost/.test(r.url())) external.push(r.url())
})
try {
  await page.setViewportSize({ width: 1480, height: 900 }).catch(() => {})
  await page.waitForSelector('[data-testid="project-item"]', { timeout: 60_000 })
  await page.click('[data-testid="project-item"]')
  await page.click('[data-testid="tab-map"]')
  await page.waitForSelector('[data-testid="graph-frame"]', { timeout: 15_000 })
  const frame = await (await page.$('[data-testid="graph-frame"]'))!.contentFrame()
  await frame!.waitForSelector('canvas', { timeout: 20_000 })
  await page.waitForTimeout(2500)
  const st = await frame!.evaluate(() => ({ vis: typeof (window as unknown as { vis?: unknown }).vis, canvases: document.querySelectorAll('canvas').length, origin: location.origin, parentReachable: (() => { try { return !!(window.parent as unknown as { lf?: unknown }).lf } catch { return false } })() }))
  check('the map renders with the bundled vis-network', st.vis === 'object' && st.canvases > 0, JSON.stringify(st))
  check('the map cannot reach the app (sandboxed frame)', !st.parentReachable)
  check('nothing was fetched from the internet', external.length === 0, external.join(' '))
  const canFetch = await frame!.evaluate(async () => { try { await fetch('https://example.com'); return true } catch { return false } })
  check('the map page has no network access', !canFetch)
  await page.screenshot({ path: path.join(outDir, 'map.png') })
  // A graph.html that is a symlink to a file outside the project is refused.
  rmSync(path.join(proj, 'graphify-out/graph.html'))
  symlinkSync('/etc/hostname', path.join(proj, 'graphify-out/graph.html'))
  const status = await page.evaluate(async () => {
    const f = document.createElement('iframe')
    f.src = 'lf-graph://project/graph-test-0001/graph.html?x=1'
    document.body.appendChild(f)
    await new Promise((r) => setTimeout(r, 1500))
    return 'ok'
  })
  const frames = page.frames().filter((f) => f.url().includes('x=1'))
  const body = frames.length ? await frames[0].evaluate(() => document.body?.innerText ?? '') : ''
  check('a symlinked graph.html pointing outside the project is refused', status === 'ok' && /Not found/.test(body), body.slice(0, 40))
} catch (e) {
  check('no unexpected error', false, String(e).split('\n').slice(0, 4).join(' | '))
  await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
  rmSync(iso, { recursive: true, force: true })
  const failed = results.filter((r) => !r[1])
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}
