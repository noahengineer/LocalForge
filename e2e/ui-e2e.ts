/**
 * UI end-to-end test: launches the real app with Playwright-for-Electron and drives it like a user.
 *
 *   npx tsx e2e/ui-e2e.ts                      # packaged app at ~/Applications/LocalForge.AppImage
 *   npx tsx e2e/ui-e2e.ts --dev                # built sources in out/ (npm run build)
 *   npx tsx e2e/ui-e2e.ts --app /path/App.AppImage --keep
 *
 * Checks: create a project through the New Project dialog, send a message, see streaming text,
 * a live Thinking block, tool cards, the live status line, a stats footer with raw timings, the
 * Agent's Desktop (noVNC canvas with real pixels), Hardware/Files/Changes/Terminal panels.
 * Screenshots are written to e2e/output/ui/.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const dev = args.includes('--dev')
const keep = args.includes('--keep')
const appPath = args.includes('--app') ? args[args.indexOf('--app') + 1] : path.join(os.homedir(), 'Applications', 'LocalForge.AppImage')
const outDir = path.resolve('e2e/output/ui')
mkdirSync(outDir, { recursive: true })

const results: Array<{ name: string; ok: boolean; detail?: string }> = []
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a)
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail })
  log(ok ? 'PASS' : 'FAIL', name, detail ?? '')
}
async function shot(page: Page, name: string) {
  const f = path.join(outDir, `${name}.png`)
  await page.screenshot({ path: f })
  log('screenshot', f)
}

async function launch(): Promise<ElectronApplication> {
  if (dev) {
    if (!existsSync('out/main/index.js')) throw new Error('out/ missing: run npm run build first')
    return electron.launch({ args: [path.resolve('out/main/index.js')], env: { ...(process.env as Record<string, string>) } })
  }
  if (!existsSync(appPath)) throw new Error(`packaged app not found: ${appPath}`)
  // AppImageLauncher (installed on this machine) would otherwise intercept the AppImage.
  return electron.launch({ executablePath: appPath, env: { ...(process.env as Record<string, string>), APPIMAGELAUNCHER_DISABLE: '1' } })
}

async function waitFor(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

const app = await launch()
const page = await app.firstWindow()
page.on('pageerror', (e) => log('[pageerror]', e.message))
page.on('dialog', (d) => void d.accept())
await page.setViewportSize({ width: 1480, height: 920 }).catch(() => {})
let projectId: string | null = null

try {
  check('app window opens', await waitFor(page, '[data-testid="sidebar"]', 60_000))
  await shot(page, '01-start')

  // --- Create a project through the UI ------------------------------------------------------
  const name = `ui-e2e-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`
  await page.click('[data-testid="new-project-button"]')
  await page.fill('[data-testid="project-name"]', name)
  await page.click('[data-testid="template-node"]')
  await shot(page, '02-new-project-dialog')
  await page.click('[data-testid="create-project-submit"]')
  await waitFor(page, '[data-testid="create-progress"]', 10_000)
  await page.waitForTimeout(1500)
  await shot(page, '03-create-progress')
  const created = await page
    .waitForSelector('[data-testid="create-progress"]', { state: 'detached', timeout: 20 * 60_000 })
    .then(() => true)
    .catch(() => false)
  check('project created via New Project dialog', created)
  const item = await page.$(`[data-testid="project-item"]:has-text("${name}")`)
  projectId = item ? await item.getAttribute('data-project-id') : null
  check('project appears in sidebar', !!projectId, projectId ?? '')
  check('composer ready', await waitFor(page, '[data-testid="composer-input"]:not([disabled])', 180_000))
  await shot(page, '04-project-open')

  // --- Send a message and watch it stream ---------------------------------------------------
  const prompt = 'Use the bash tool to run `node --version` and `uname -a`, then tell me in two short sentences what you found.'
  await page.fill('[data-testid="composer-input"]', prompt)
  await page.keyboard.press('Enter')
  check('user message shown', await waitFor(page, '[data-testid="user-message"]', 15_000))
  const sawLive = await waitFor(page, '[data-testid="live-status"]', 60_000)
  check('live status line shows while generating', sawLive)
  if (await waitFor(page, '[data-testid="live-status"][data-phase="prompt"]', 30_000)) {
    await shot(page, '05-prompt-processing')
    check('prompt-processing progress shown', !!(await page.$('[data-testid="prompt-progress-text"]')))
  }
  const sawThinking = await waitFor(page, '[data-testid="thinking-block"][data-active="true"]', 6 * 60_000)
  check('live Thinking block renders (expanded while thinking)', sawThinking)
  if (sawThinking) {
    await page.waitForTimeout(2500)
    await shot(page, '06-thinking-live')
  }
  // Queue a follow-up while the agent is busy.
  await page.fill('[data-testid="composer-input"]', 'Reply with exactly this word and nothing else: QUEUEDOK')
  await page.keyboard.press('Enter')
  check('message typed while busy is queued', await waitFor(page, '[data-testid="queue"]', 5000))
  await shot(page, '06b-queued')
  const sawTool = await waitFor(page, '[data-testid="tool-card"][data-tool="bash"]', 8 * 60_000)
  check('bash tool card renders', sawTool)
  if (sawTool) await shot(page, '07-tool-card')
  // Streaming text: the answer arrives token by token.
  let streamingSeen = false
  let lengths: number[] = []
  const streamDeadline = Date.now() + 12 * 60_000
  while (Date.now() < streamDeadline) {
    const el = await page.$('[data-testid="assistant-text"][data-streaming="true"]')
    if (el) {
      streamingSeen = true
      const len = (await el.innerText()).length
      lengths.push(len)
      if (lengths.length === 3) await shot(page, '08-streaming-text')
      if (lengths.length >= 6) break
      await page.waitForTimeout(700)
      continue
    }
    if (!(await page.$('[data-testid="stop-button"]')) && (await page.$('[data-testid="assistant-text"]'))) break
    await page.waitForTimeout(400)
  }
  const grew = lengths.length >= 2 && lengths[lengths.length - 1] > lengths[0]
  check('assistant text streams (grows while generating)', streamingSeen && grew, `lengths=${lengths.join(',')}`)
  // Wait for the turn to finish.
  const finished = await page
    .waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 15 * 60_000 })
    .then(() => true)
    .catch(() => false)
  check('turn completes', finished)
  await page.waitForTimeout(2500)
  const thinkingDone = await page.$('[data-testid="thinking-block"][data-active="false"]')
  check('Thinking block auto-collapses after thinking', !!thinkingDone)
  const meta = thinkingDone ? await (await thinkingDone.$('[data-testid="thinking-meta"]'))?.innerText() : ''
  check('Thinking header shows duration and token count', !!meta && /for .*\d/.test(meta) && /tokens/.test(meta), meta ?? '')
  const footer = await waitFor(page, '[data-testid="stats-footer"]', 20_000)
  check('stats footer on assistant message', footer)
  await shot(page, '09-turn-complete')
  if (footer) {
    await page.click('[data-testid="stats-footer"] >> nth=-1 >> button')
    check('raw timings expand', await waitFor(page, '[data-testid="raw-timings"]', 5000))
    await shot(page, '10-raw-timings')
  }
  const ctx = await page.$('[data-testid="context-text"]')
  const ctxText = ctx ? await ctx.innerText() : ''
  check('context meter shows used / max', /^[\d,]+ \/ [\d,]+$/.test(ctxText) && !ctxText.startsWith('0 /'), ctxText)

  // The queued follow-up is sent automatically once the first turn is done.
  const queuedSent = await waitFor(page, '[data-testid="user-message"]:has-text("QUEUEDOK")', 60_000)
  check('queued message is sent when the agent becomes idle', queuedSent)
  const queuedAnswered = await page
    .waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-text"]')].some((e) => /QUEUEDOK/.test(e.textContent ?? '')), null, { timeout: 10 * 60_000 })
    .then(() => true)
    .catch(() => false)
  check('queued message gets answered', queuedAnswered)
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 10 * 60_000 }).catch(() => {})

  // @file mentions (OpenCode's file finder inside the sandbox).
  await page.fill('[data-testid="composer-input"]', '')
  await page.type('[data-testid="composer-input"]', 'look at @pack')
  const mention = await waitFor(page, '[data-testid="mention-popup"]:has-text("package.json")', 10_000)
  check('@ mention suggests project files', mention)
  if (mention) {
    await shot(page, '09b-mention')
    await page.keyboard.press('Enter')
    const v = await page.inputValue('[data-testid="composer-input"]')
    check('@ mention inserts the file path', v.includes('@package.json'), v)
  }
  await page.fill('[data-testid="composer-input"]', '')

  // Image paste + vision: paste a solid red PNG and ask for its colour.
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 96
    c.height = 96
    const g = c.getContext('2d')!
    g.fillStyle = '#e01010'
    g.fillRect(0, 0, 96, 96)
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'red.png', { type: 'image/png' }))
    const ta = document.querySelector('[data-testid="composer-input"]')!
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(500)
  const thumb = await page.$('img[src^="data:image/png"]')
  check('pasted image shows as a thumbnail', !!thumb)
  await page.fill('[data-testid="composer-input"]', 'What single colour fills the attached image? Answer with one word.')
  await page.keyboard.press('Enter')
  const visionOk = await page
    .waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-text"]')].some((e) => /\bred\b/i.test(e.textContent ?? '')), null, { timeout: 10 * 60_000 })
    .then(() => true)
    .catch(() => false)
  check('model sees the pasted image (answers "red")', visionOk)
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 10 * 60_000 }).catch(() => {})
  await shot(page, '09c-vision')

  // Stop button aborts a running generation.
  await page.fill('[data-testid="composer-input"]', 'Write a detailed 800-word essay about the history of blacksmithing. Do not use any tools.')
  await page.keyboard.press('Enter')
  await waitFor(page, '[data-testid="live-status"][data-phase="writing"], [data-testid="live-status"][data-phase="thinking"]', 5 * 60_000)
  await page.waitForTimeout(3000)
  const tStop = Date.now()
  await page.click('[data-testid="stop-button"]')
  const stopped = await page
    .waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  let slotsBusy = -1
  for (let i = 0; i < 10; i++) {
    slotsBusy = await fetch('http://127.0.0.1:8080/slots')
      .then((r) => r.json())
      .then((s: Array<{ is_processing: boolean }>) => s.filter((x) => x.is_processing).length)
      .catch(() => -1)
    if (slotsBusy === 0) break
    await page.waitForTimeout(500)
  }
  check('Stop aborts the agent and frees the GPU', stopped && slotsBusy === 0, `stopped in ${Date.now() - tStop} ms, busy llama slots: ${slotsBusy}`)
  await shot(page, '09d-stopped')

  // Plan mode + the agent's question tool, in a fresh session (the stopped essay above would
  // otherwise still be pending in this session's history): the question card renders and answering
  // it resumes the agent.
  await page.click('[data-testid="new-session"]')
  await waitFor(page, '[data-testid="composer-input"]:not([disabled])', 60_000)
  await page.waitForTimeout(1000)
  await page.click('[data-testid="composer-input"]')
  await page.keyboard.press('Tab')
  await page.fill(
    '[data-testid="composer-input"]',
    'Use the question tool to ask me exactly one multiple-choice question: "Which language should we use?" with the options TypeScript and Python. After I answer, reply with just the chosen language.',
  )
  await page.keyboard.press('Enter')
  const qCard = await waitFor(page, '[data-testid="question-card"]', 8 * 60_000)
  check('Plan mode: agent question renders as a question card', qCard)
  if (qCard) {
    await shot(page, '09e-question')
    const before = (await page.$$('[data-testid="assistant-text"]')).length
    const opt = await page.$('[data-testid="question-card"] button:has-text("TypeScript")')
    if (opt) await opt.click()
    else await page.fill('[data-testid="question-card"] input', 'TypeScript')
    await page.click('[data-testid="question-card"] button:has-text("Answer")')
    const gone = await page
      .waitForSelector('[data-testid="question-card"]', { state: 'detached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    const got = await page
      .waitForFunction((n) => [...document.querySelectorAll('[data-testid="assistant-text"]')].slice(n).some((e) => /TypeScript/.test(e.textContent ?? '')), before, { timeout: 8 * 60_000 })
      .then(() => true)
      .catch(() => false)
    check('answering the question card resumes the agent', gone && got)
  }
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 10 * 60_000 }).catch(() => {})
  await page.click('[data-testid="composer-input"]')
  await page.keyboard.press('Tab') // back to Build

  // --- Agent's Desktop ------------------------------------------------------------------------
  await page.click('[data-testid="tab-desktop"]')
  const vnc = await waitFor(page, '[data-testid="desktop-panel"][data-vnc-state="connected"]', 60_000)
  check("Agent's Desktop connects (noVNC)", vnc)
  await page.waitForTimeout(2500)
  const pixels = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="desktop-panel"] canvas') as HTMLCanvasElement | null
    if (!c) return null
    const ctx = c.getContext('2d')
    if (!ctx) return null
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const colors = new Set<number>()
    for (let i = 0; i < d.length; i += 4 * 97) colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
    return { w: c.width, h: c.height, distinctColors: colors.size }
  })
  check("Agent's Desktop shows the desktop (canvas has real content)", !!pixels && pixels.w >= 1000 && pixels.distinctColors > 20, JSON.stringify(pixels))
  await shot(page, '11-agent-desktop')
  await page.click('[data-testid="vnc-take-control"]')
  await page.waitForTimeout(500)
  await shot(page, '12-take-control')
  await page.click('[data-testid="vnc-view-only"]')

  // --- Other panels -------------------------------------------------------------------------
  await page.click('[data-testid="tab-hardware"]')
  await page.waitForTimeout(2000)
  const vram = await page.$('[data-testid="vram-text"]')
  check('Hardware panel shows live GPU data', !!vram && /GiB|MiB/.test(await vram.innerText()), vram ? await vram.innerText() : '')
  await shot(page, '13-hardware')
  await page.click('[data-testid="tab-changes"]')
  await page.waitForTimeout(4000)
  check('Changes panel lists checkpoints', !!(await page.$('[data-testid="checkpoint-item"]')))
  await shot(page, '14-changes')
  await page.click('[data-testid="tab-files"]')
  await page.waitForTimeout(1500)
  await page.click('[data-testid="files-panel"] >> text=package.json').catch(() => {})
  await page.waitForTimeout(1000)
  await shot(page, '15-files')
  await page.click('[data-testid="tab-terminal"]')
  await page.waitForTimeout(4000)
  await page.click('[data-testid="terminal-panel"] .xterm').catch(() => {})
  await page.keyboard.type('echo LF_TERM_$((40+2)) && whoami\n')
  await page.waitForTimeout(2500)
  const termText = await page.evaluate(() => document.querySelector('[data-testid="terminal-panel"] .xterm-rows')?.textContent ?? '')
  check('Terminal runs commands inside the sandbox', termText.includes('LF_TERM_42') && termText.includes('dev'), termText.slice(-120))
  await shot(page, '16-terminal')

  // Plan/Build toggle via Tab
  await page.click('[data-testid="composer-input"]')
  await page.keyboard.press('Tab')
  const mode = await page.getAttribute('[data-testid="mode-toggle"]', 'data-mode')
  check('Tab toggles Plan mode', mode === 'plan', mode ?? '')
  await page.keyboard.press('Tab')
} catch (e) {
  check('no unexpected error', false, e instanceof Error ? e.stack : String(e))
  await shot(page, '99-error').catch(() => {})
} finally {
  if (projectId && !keep) {
    await page.evaluate((id) => (window as unknown as { lf: { call: (m: string, ...a: unknown[]) => Promise<unknown> } }).lf.call('removeProject', id, true), projectId).catch(() => {})
    log('removed test project', projectId)
  }
  await app.close().catch(() => {})
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  for (const f of failed) console.log('  FAILED:', f.name, f.detail ?? '')
  process.exit(failed.length ? 1 : 0)
}
