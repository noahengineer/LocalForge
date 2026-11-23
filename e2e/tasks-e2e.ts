/**
 * Tasks box: the agent's todo list (OpenCode `todo.updated` events) shows at the top of the side
 * panel and ticks off live. Isolated instance (own dirs, fake failing podman); the events are sent
 * the way the backend forwards OpenCode's.
 *   npx electron-vite build && npx tsx e2e/tasks-e2e.ts
 */
import { _electron as electron } from 'playwright'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const iso = mkdtempSync(path.join(os.tmpdir(), 'lf-tasks-'))
for (const d of ['cfg/LocalForge', 'data', 'fakebin', 'proj']) mkdirSync(path.join(iso, d), { recursive: true })
writeFileSync(path.join(iso, 'cfg/LocalForge/settings.json'), JSON.stringify({ proxy: { port: 18083 } }))
writeFileSync(path.join(iso, 'fakebin/podman'), '#!/bin/sh\nexit 125\n')
chmodSync(path.join(iso, 'fakebin/podman'), 0o755)
const PID = 'tasks-test-0001'
const SID = 'ses_tasks_test'
writeFileSync(path.join(iso, 'data/projects.json'), JSON.stringify([{ id: PID, name: 'Tasks test', path: path.join(iso, 'proj'), template: 'empty', description: '', createdAt: Date.now(), checkpoints: false, lastSessionId: SID }]))

const outDir = path.resolve('e2e/output/tasks')
mkdirSync(outDir, { recursive: true })
const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = '') => {
  results.push([n, ok, d])
  console.log(ok ? 'PASS' : 'FAIL', n, d)
}
const app = await electron.launch({
  args: [path.resolve('out/main/index.js'), `--user-data-dir=${iso}/ud`],
  env: { ...(process.env as Record<string, string>), PATH: `${iso}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: `${iso}/cfg`, LOCALFORGE_DATA_DIR: `${iso}/data` },
})
const page = await app.firstWindow()
const todos = (statuses: string[]) =>
  ['Set up the project', 'Write the game logic', 'Draw the board', 'Add high scores'].map((content, i) => ({ id: `t${i}`, content, status: statuses[i], priority: 'medium' }))
const emit = (list: unknown[]) =>
  app.evaluate(({ BrowserWindow }, a) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('backend-event', { type: 'oc', projectId: a.pid, event: { type: 'todo.updated', properties: { sessionID: a.sid, todos: a.list } } })
  }, { pid: PID, sid: SID, list })
try {
  await page.setViewportSize({ width: 1480, height: 900 }).catch(() => {})
  await page.waitForSelector('[data-testid="right-panel"]', { timeout: 60_000 })
  await page.waitForTimeout(1500)
  check('no Tasks box while there are no tasks', (await page.locator('[data-testid="tasks-box"]').count()) === 0)
  await emit(todos(['pending', 'pending', 'pending', 'pending']))
  await page.waitForSelector('[data-testid="tasks-box"]', { timeout: 5000 })
  check('the task list appears with 0/4', (await page.textContent('[data-testid="tasks-count"]')) === '0/4')
  await emit(todos(['completed', 'in_progress', 'pending', 'pending']))
  await page.waitForTimeout(300)
  const st = await page.$$eval('[data-testid="tasks-list"] li', (els) => els.map((e) => e.getAttribute('data-status')))
  check('tasks tick off live (1/4, second in progress)', (await page.textContent('[data-testid="tasks-count"]')) === '1/4' && st[1] === 'in_progress', st.join(','))
  for (const tab of ['files', 'map', 'desktop']) {
    await page.click(`[data-testid="tab-${tab}"]`)
    check(`stays visible on the ${tab} tab`, await page.isVisible('[data-testid="tasks-box"]'))
  }
  await page.screenshot({ path: path.join(outDir, 'tasks.png') })
  await page.click('[data-testid="tasks-toggle"]')
  check('collapses to one line showing the current task', !(await page.isVisible('[data-testid="tasks-list"]')) && /Write the game logic/.test((await page.textContent('[data-testid="tasks-box"]')) ?? ''))
  await page.screenshot({ path: path.join(outDir, 'tasks-collapsed.png') })
  await page.click('[data-testid="tasks-toggle"]')
  await emit(todos(['completed', 'completed', 'completed', 'cancelled']))
  await page.waitForTimeout(300)
  check('cancelled tasks are not counted (3/3)', (await page.textContent('[data-testid="tasks-count"]')) === '3/3')
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
