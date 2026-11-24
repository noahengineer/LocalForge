/**
 * API models, end to end in an isolated instance (own config/data, proxy on 18081, fake podman,
 * `--password-store=basic` so no system keyring prompt), against a fake OpenAI-compatible API:
 *   npx electron-vite build && npx tsx e2e/api-models-e2e.ts
 * Covers: "Add API models…" in the model menu, adding a custom API, saving a key (never shown
 * again, not in settings.json), loading its model list with the key, adding a model, picking it
 * in the chat's model menu (label, effort pill hidden), the stats proxy sending its requests to
 * the API with the key, and removing the API (back to the local model).
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEY = 'sk-test-e2e-123456'
const seen: Array<{ method: string; url: string; auth: string | undefined; body: Record<string, unknown> }> = []
const fake = http.createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: b ? JSON.parse(b) : {} })
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 'fake-coder-1', name: 'Fake Coder', context_length: 200000, supported_parameters: ['tools'] },
            { id: 'fake-chat-notools', name: 'Fake Chat', context_length: 8000, supported_parameters: [] },
          ],
        }),
      )
      return
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello from fake api' } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
const apiUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`

const iso = mkdtempSync(path.join(os.tmpdir(), 'lf-api-'))
for (const d of ['cfg/LocalForge', 'data', 'fakebin', 'proj']) mkdirSync(path.join(iso, d), { recursive: true })
writeFileSync(path.join(iso, 'cfg/LocalForge/settings.json'), JSON.stringify({ proxy: { port: 18081 } }))
writeFileSync(path.join(iso, 'fakebin/podman'), '#!/bin/sh\necho "podman disabled for this test" >&2\nexit 125\n')
chmodSync(path.join(iso, 'fakebin/podman'), 0o755)
writeFileSync(
  path.join(iso, 'data/projects.json'),
  JSON.stringify([{ id: 'api-test-0001', name: 'API test', path: path.join(iso, 'proj'), template: 'empty', description: '', createdAt: Date.now(), checkpoints: false }]),
)
const outDir = path.resolve('e2e/output/api-models')
mkdirSync(outDir, { recursive: true })
const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = '') => {
  results.push([n, ok, d])
  console.log(ok ? 'PASS' : 'FAIL', n, d)
}
const settingsJson = () => JSON.parse(readFileSync(path.join(iso, 'cfg/LocalForge/settings.json'), 'utf8'))

const app: ElectronApplication = await electron.launch({
  args: [path.resolve('out/main/index.js'), `--user-data-dir=${iso}/ud`, '--password-store=basic'],
  env: { ...(process.env as Record<string, string>), PATH: `${iso}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: `${iso}/cfg`, LOCALFORGE_DATA_DIR: `${iso}/data` },
})
const page: Page = await app.firstWindow()
try {
  await page.setViewportSize({ width: 1480, height: 900 }).catch(() => {})
  await page.waitForSelector('[data-testid="topbar"]', { timeout: 60_000 })
  await page.click('[data-testid="project-item"]')
  await page.waitForSelector('[data-testid="model-pill"]')

  await page.click('[data-testid="model-pill"]')
  await page.click('[data-testid="model-add-api"]')
  await page.waitForSelector('[data-testid="api-models"]')
  check('"Add API models…" opens Settings on the API page', true)
  check('Venice is offered as a ready-made API', (await page.locator('[data-testid="api-add-venice"]').count()) === 1)

  await page.click('text=Other…')
  await page.fill('input[placeholder="Name"]', 'Fake')
  await page.fill('input[placeholder="https://example.com/v1"]', apiUrl)
  await page.click('[data-testid="api-models"] button:has-text("Add"):not(:has-text("Add an"))')
  await page.waitForSelector('[data-testid="api-provider-fake"]')
  check('custom API added', settingsJson().api.providers[0]?.baseUrl === apiUrl, JSON.stringify(settingsJson().api.providers))

  await page.fill('[data-testid="api-key-input"]', KEY)
  await page.click('button:has-text("Save key")')
  await page.waitForSelector('button:has-text("Remove key")')
  check('key saved; the field is cleared and shows it is saved', (await page.inputValue('[data-testid="api-key-input"]')) === '')
  const cfgText = readFileSync(path.join(iso, 'cfg/LocalForge/settings.json'), 'utf8')
  check('the key is not in settings.json', !cfgText.includes(KEY))
  check('the key is not in the renderer (settings state)', !(await page.evaluate(() => JSON.stringify(document.body.innerHTML))).includes(KEY))

  await page.click('[data-testid="api-browse"]')
  await page.waitForSelector('[data-testid="api-browser"] >> text=Fake Coder')
  const modelsReq = seen.find((s) => s.url === '/v1/models')
  check('model list fetched with the key', modelsReq?.auth === `Bearer ${KEY}`, modelsReq?.auth ?? 'none')
  check('a model without tool calling is marked', (await page.locator('[data-testid="api-browser"] >> text=can\'t use tools').count()) === 1)
  await page.screenshot({ path: path.join(outDir, 'settings-api.png') })
  await page.click('[data-testid="api-add-model-fake-coder-1"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="api-provider-fake"]')?.textContent?.includes('200K context'))
  const m = settingsJson().api.providers[0].models[0]
  check('model added with its context size', m?.id === 'fake-coder-1' && m.contextLimit === 200000, JSON.stringify(m))

  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="api-models"]', { state: 'detached', timeout: 5000 }).catch(async () => {
    await page.click('button[aria-label="Close"]').catch(() => {})
  })
  await page.click('[data-testid="model-pill"]')
  await page.waitForSelector('[data-testid="model-api"]')
  await page.screenshot({ path: path.join(outDir, 'model-menu.png') })
  await page.click('[data-testid="model-api"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="model-pill"]')?.textContent?.includes('Fake Coder'))
  check('picking the API model changes the pill', true)
  check('the choice is saved', settingsJson().api.active === 'fake/fake-coder-1', settingsJson().api.active)
  check('effort pill is hidden for API models', (await page.locator('[data-testid="effort-pill"]').count()) === 0)
  check('top bar shows the API model', ((await page.textContent('[data-testid="model-status"]')) ?? '').includes('Fake Coder'))
  await page.screenshot({ path: path.join(outDir, 'composer-api.png') })

  // What OpenCode in a sandbox would send, through this instance's stats proxy.
  const r = await fetch('http://127.0.0.1:18081/p/api-test-0001/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer localforge' },
    body: JSON.stringify({ model: 'lf-api/fake/fake-coder-1', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const text = await r.text()
  const chat = seen.find((s) => s.url === '/v1/chat/completions')
  check('proxy answers with the API reply', r.status === 200 && text.includes('hello from fake api'), String(r.status))
  check('the API got the real model id and the key', chat?.body.model === 'fake-coder-1' && chat.auth === `Bearer ${KEY}`, `${chat?.body.model} ${chat?.auth}`)
  const other = await fetch('http://127.0.0.1:18081/p/api-test-0001/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'lf-api/fake/fake-chat-notools', messages: [] }),
  })
  check('models that were not added are refused', other.status === 404, String(other.status))

  // Remove the API: back to the local model.
  page.on('dialog', (d) => void d.accept())
  await page.click('[data-testid="model-pill"]')
  await page.click('[data-testid="model-add-api"]')
  await page.click('[data-testid="api-provider-fake"] button[title="Remove this API"]')
  await page.waitForSelector('[data-testid="api-provider-fake"]', { state: 'detached' })
  check('removing the API goes back to the local model', settingsJson().api.active === '' && settingsJson().api.providers.length === 0)
  check('its key is deleted', !readFileSync(path.join(iso, 'cfg/LocalForge/api-keys.json'), 'utf8').includes('fake'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('effort pill is back', (await page.locator('[data-testid="effort-pill"]').count()) === 1)
} catch (e) {
  check('no exception', false, String(e))
  await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {})
} finally {
  await app.close()
  fake.close()
}
const failed = results.filter((r) => !r[1])
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
