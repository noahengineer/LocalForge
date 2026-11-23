/**
 * Stats verification: the numbers LocalForge shows must match llama-server's own reports.
 *
 *   npx tsx e2e/stats-verify.ts [--dev] [--app <AppImage>] [--tokens 20000] [--keep]
 *
 * Drives the real app (Playwright-for-Electron), sends a large *uncached* prompt and compares:
 *  - the UI's message stats footer + raw timings (prompt tokens, cached, output tokens, prompt t/s,
 *    generation t/s) against llama-server's own per-request log lines (journalctl
 *    "prompt eval time" / "eval time" / "stop processing: n_tokens") and /metrics counter deltas;
 *  - the context meter against the slot's KV usage reported by llama-server;
 *  - that the prompt-processing progress bar moves (several distinct server progress updates and
 *    increasing on-screen percentages);
 *  - that the Hardware panel shows live GPU data during generation.
 * Report: e2e/output/stats/report.md (+ screenshots).
 */
import { _electron as electron, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const dev = args.includes('--dev')
const keep = args.includes('--keep')
const appPath = args.includes('--app') ? args[args.indexOf('--app') + 1] : path.join(os.homedir(), 'Applications', 'LocalForge.AppImage')
const targetTokens = args.includes('--tokens') ? Number(args[args.indexOf('--tokens') + 1]) : 20000
const LLAMA = 'http://127.0.0.1:8080'
const outDir = path.resolve('e2e/output/stats')
mkdirSync(outDir, { recursive: true })
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a)
const results: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail })
  log(ok ? 'PASS' : 'FAIL', name, detail ? `| ${detail}` : '')
}

async function metrics(): Promise<Record<string, number>> {
  const t = await (await fetch(`${LLAMA}/metrics`)).text()
  const m: Record<string, number> = {}
  for (const l of t.split('\n')) {
    const r = /^(llamacpp:[a-z_]+)(?:\{[^}]*\})?\s+(\S+)/.exec(l)
    if (r) m[r[1]] = Number(r[2])
  }
  return m
}

/** llama-server's own per-request report from its log (journalctl --user -u llama.service). */
function llamaLogSince(since: Date) {
  const out = execFileSync('journalctl', ['--user', '-u', 'llama.service', '--no-pager', '-o', 'cat', '--since', since.toISOString().replace('T', ' ').slice(0, 19)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const tasks = new Map<number, { promptMs?: number; promptN?: number; promptTps?: number; evalMs?: number; evalN?: number; evalTps?: number; nTokens?: number }>()
  for (const l of out.split('\n')) {
    let m = /task (\d+) \| prompt eval time =\s+([\d.]+) ms \/\s+(\d+) tokens \(.*?,\s+([\d.]+) tokens per second\)/.exec(l)
    if (m) tasks.set(Number(m[1]), { ...tasks.get(Number(m[1])), promptMs: +m[2], promptN: +m[3], promptTps: +m[4] })
    m = /task (\d+) \|\s+eval time =\s+([\d.]+) ms \/\s+(\d+) tokens \(.*?,\s+([\d.]+) tokens per second\)/.exec(l)
    if (m) tasks.set(Number(m[1]), { ...tasks.get(Number(m[1])), evalMs: +m[2], evalN: +m[3], evalTps: +m[4] })
    m = /task (\d+) \| stop processing: n_tokens = (\d+)/.exec(l)
    if (m) tasks.set(Number(m[1]), { ...tasks.get(Number(m[1])), nTokens: +m[2] })
  }
  return [...tasks.entries()].map(([task, v]) => ({ task, ...v }))
}

/** Unique, uncacheable filler text of roughly `tokens` tokens. */
function bigDocument(tokens: number): string {
  const words = 'anvil ember forge hammer quench temper billet crucible bellows tongs flux slag ingot alloy carbon steel iron copper bronze tin smith spark coal draft weld rivet chisel file grind polish hearth tuyere'.split(' ')
  const seed = Date.now()
  let x = seed % 2147483647
  const rnd = () => (x = (x * 48271) % 2147483647) / 2147483647
  const lines: string[] = [`Run id ${seed}.`]
  let approx = 0
  let i = 0
  while (approx < tokens) {
    const n = 12 + Math.floor(rnd() * 10)
    const w = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)])
    lines.push(`${++i}. ${w.join(' ')}.`)
    approx += n * 1.25 + 4
  }
  return lines.join('\n')
}

const fmt1 = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1)) // same as the UI's fmtTps

async function launch() {
  if (dev) return electron.launch({ args: [path.resolve('out/main/index.js')], env: { ...(process.env as Record<string, string>) } })
  if (!existsSync(appPath)) throw new Error(`packaged app not found: ${appPath}`)
  return electron.launch({ executablePath: appPath, env: { ...(process.env as Record<string, string>), APPIMAGELAUNCHER_DISABLE: '1' } })
}

const app = await launch()
const page: Page = await app.firstWindow()
page.on('dialog', (d) => void d.accept())
await page.setViewportSize({ width: 1480, height: 920 }).catch(() => {})
let projectId: string | null = null
const report: string[] = []

try {
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 60_000 })
  // A fresh, empty project keeps the comparison clean.
  const name = `stats-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`
  await page.click('[data-testid="new-project-button"]')
  await page.fill('[data-testid="project-name"]', name)
  await page.click('[data-testid="template-empty"]')
  await page.click('[data-testid="create-project-submit"]')
  await page.waitForSelector('[data-testid="create-progress"]', { state: 'detached', timeout: 20 * 60_000 })
  projectId = await page.getAttribute(`[data-testid="project-item"]:has-text("${name}")`, 'data-project-id')
  await page.waitForSelector('[data-testid="composer-input"]:not([disabled])', { timeout: 180_000 })
  log('project ready', projectId)

  const doc = bigDocument(targetTokens)
  const prompt = `Below is a long numbered list. Do not use any tools. After reading it, reply with exactly one short sentence saying how many lines it has (the last line number).\n\n${doc}`
  const m0 = await metrics()
  const since = new Date(Date.now() - 2000)
  await page.fill('[data-testid="composer-input"]', prompt)
  await page.keyboard.press('Enter')
  log(`sent prompt (${prompt.length} chars, ~${targetTokens} tokens)`)

  // Watch prompt processing: on-screen % and raw server progress values.
  const uiPct: number[] = []
  const serverProcessed: number[] = []
  let midShot = false
  let hwShot = false
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    const pctText = await page.$eval('[data-testid="prompt-progress-text"]', (e) => e.textContent ?? '').catch(() => null)
    if (pctText) {
      const pct = Number(/^(\d+)%/.exec(pctText)?.[1] ?? NaN)
      if (Number.isFinite(pct) && pct !== uiPct[uiPct.length - 1]) uiPct.push(pct)
      if (!midShot && pct >= 25 && pct <= 75) {
        await page.screenshot({ path: path.join(outDir, 'prompt-progress.png') })
        midShot = true
      }
    }
    const raw = await page.evaluate(() => {
      const st = (window as unknown as { __lf: { getState: () => { live: Record<string, { promptProcessed: number | null; phase: string; kind: string }> } } }).__lf.getState()
      return Object.values(st.live).filter((r) => r.kind === 'agent').map((r) => ({ p: r.promptProcessed, phase: r.phase }))
    })
    for (const r of raw) if (r.p !== null && r.p !== serverProcessed[serverProcessed.length - 1]) serverProcessed.push(r.p)
    if (raw.some((r) => r.phase === 'thinking' || r.phase === 'writing')) {
      if (!hwShot) {
        await page.click('[data-testid="tab-hardware"]')
        await page.waitForTimeout(2500)
        await page.screenshot({ path: path.join(outDir, 'hardware-during-generation.png') })
        const vram = await page.$eval('[data-testid="vram-text"]', (e) => e.textContent ?? '').catch(() => '')
        const gpuData = await page.evaluate(() => {
          const h = (window as unknown as { __lf: { getState: () => { hardware: Array<{ t: number; tps: number; gpu: { vramUsedMiB: number; utilPct: number } | null }> } } }).__lf.getState().hardware
          const recent = h.slice(-5)
          return { samples: h.length, recentT: recent.map((s) => s.t), tps: recent.map((s) => s.tps), util: recent.map((s) => s.gpu?.utilPct ?? null), vram: recent.map((s) => s.gpu?.vramUsedMiB ?? null) }
        })
        const live = gpuData.recentT.length >= 2 && gpuData.recentT[gpuData.recentT.length - 1] > gpuData.recentT[0] && gpuData.vram.every((v) => v !== null && v > 0)
        check('Hardware panel shows live GPU data during generation', !!vram && live && gpuData.tps.some((t) => t > 0), `${vram}; util=${gpuData.util.join(',')}%; tps=${gpuData.tps.join(',')}`)
        hwShot = true
      }
    }
    if (!(await page.$('[data-testid="stop-button"]')) && uiPct.length > 0) break
    await page.waitForTimeout(300)
  }
  await page.waitForSelector('[data-testid="stop-button"]', { state: 'detached', timeout: 30 * 60_000 })
  await page.waitForTimeout(3000)
  const m1 = await metrics()

  const increasing = (a: number[]) => a.every((v, i) => i === 0 || v >= a[i - 1])
  check('prompt-processing progress bar moves (on-screen %)', uiPct.length >= 4 && increasing(uiPct) && uiPct[uiPct.length - 1] > uiPct[0], `UI %: ${uiPct.join(' → ')}`)
  check('llama-server sent several prompt-progress updates', serverProcessed.length >= 3 && increasing(serverProcessed), `processed: ${serverProcessed.join(' → ')}`)

  // --- UI numbers for the final assistant message -------------------------------------------
  await page.click('[data-testid="tab-desktop"]')
  const footers = await page.$$('[data-testid="stats-footer"]')
  const footer = footers[footers.length - 1]
  const footerText = (await footer.innerText()).replace(/\s+/g, ' ')
  await footer.$eval('button', (b) => (b as HTMLButtonElement).click())
  await page.waitForSelector('[data-testid="raw-timings"]')
  await page.screenshot({ path: path.join(outDir, 'footer-raw-timings.png') })
  const raw = await page.$$eval('[data-testid="raw-timings"] tr', (rows) => Object.fromEntries(rows.map((r) => [r.children[0].textContent, r.children[1].textContent])))
  const ctxText = await page.$eval('[data-testid="context-text"]', (e) => e.textContent ?? '')
  log('footer:', footerText)
  log('context meter:', ctxText)
  const f = /prompt ([\d,]+)(?: \(([\d,]+) cached\))? thinking ([\d,]+) output ([\d,]+) pp ([\d.]+) t\/s gen ([\d.]+) t\/s/.exec(footerText)
  if (!f) throw new Error(`could not parse footer: ${footerText}`)
  const num = (s: string | undefined) => Number((s ?? '0').replace(/,/g, ''))
  const ui = {
    promptTokens: num(f[1]),
    cached: num(f[2]),
    thinking: num(f[3]),
    output: num(f[4]),
    ppTps: f[5],
    genTps: f[6],
    contextUsed: num(ctxText.split('/')[0]),
    raw: {
      prompt_n: Number(raw.prompt_n),
      cache_n: Number(raw.cache_n),
      predicted_n: Number(raw.predicted_n),
      prompt_ms: Number(raw.prompt_ms),
      predicted_ms: Number(raw.predicted_ms),
      prompt_per_second: Number(raw.prompt_per_second),
      predicted_per_second: Number(raw.predicted_per_second),
    },
  }

  // --- llama-server's own report for the same request ----------------------------------------
  const tasks = llamaLogSince(since).filter((t) => t.promptN !== undefined && t.evalN !== undefined)
  // The request we sent is the one whose processed-prompt count matches the UI's raw prompt_n.
  const L = tasks.find((t) => t.promptN === ui.raw.prompt_n && t.evalN === ui.raw.predicted_n) ?? tasks[tasks.length - 1]
  const dPrompt = (m1['llamacpp:prompt_tokens_total'] ?? 0) - (m0['llamacpp:prompt_tokens_total'] ?? 0)
  const dPred = (m1['llamacpp:tokens_predicted_total'] ?? 0) - (m0['llamacpp:tokens_predicted_total'] ?? 0)
  const dCached = (m1['llamacpp:prompt_tokens_cached_total'] ?? 0) - (m0['llamacpp:prompt_tokens_cached_total'] ?? 0)
  log('llama-server log for the request:', JSON.stringify(L))
  log('/metrics deltas:', JSON.stringify({ dPrompt, dPred, dCached, requests: tasks.length }))

  check('found llama-server log entry for the request', !!L && L.promptN === ui.raw.prompt_n, `task ${L?.task}, ${tasks.length} request(s) in window`)
  check('prompt tokens processed: UI == llama-server log', ui.raw.prompt_n === L.promptN, `UI ${ui.raw.prompt_n} vs log ${L.promptN}`)
  check('prompt tokens in UI footer == processed + cached', ui.promptTokens === ui.raw.prompt_n + ui.raw.cache_n && ui.cached === ui.raw.cache_n, `${ui.promptTokens} = ${ui.raw.prompt_n} + ${ui.raw.cache_n}`)
  check('output tokens: UI == llama-server log', ui.output === L.evalN && ui.raw.predicted_n === L.evalN, `UI ${ui.output} vs log ${L.evalN}`)
  check('prompt-processing speed: UI == llama-server log', ui.ppTps === fmt1(L.promptTps!) && Math.abs(ui.raw.prompt_per_second - L.promptTps!) < 0.01, `UI ${ui.ppTps} t/s (raw ${ui.raw.prompt_per_second.toFixed(2)}) vs log ${L.promptTps}`)
  check('generation speed: UI == llama-server log', ui.genTps === fmt1(L.evalTps!) && Math.abs(ui.raw.predicted_per_second - L.evalTps!) < 0.01, `UI ${ui.genTps} t/s (raw ${ui.raw.predicted_per_second.toFixed(2)}) vs log ${L.evalTps}`)
  check('prompt/eval times: UI == llama-server log', Math.abs(ui.raw.prompt_ms - L.promptMs!) < 0.01 && Math.abs(ui.raw.predicted_ms - L.evalMs!) < 0.01, `prompt ${ui.raw.prompt_ms} vs ${L.promptMs} ms; eval ${ui.raw.predicted_ms} vs ${L.evalMs} ms`)
  // KV usage after the request: llama-server reports n_tokens at slot release (prompt + generated tokens
  // that were decoded into the cache; the final sampled token is never decoded, hence the -1).
  const ctxExpected = ui.raw.prompt_n + ui.raw.cache_n + ui.raw.predicted_n
  check('context meter == prompt + generated tokens of the request', ui.contextUsed === ctxExpected, `UI ${ui.contextUsed} vs ${ctxExpected}`)
  check('context meter matches llama-server KV usage (n_tokens at release, +1 final token)', L.nTokens !== undefined && Math.abs(ui.contextUsed - (L.nTokens + 1)) <= 0, `UI ${ui.contextUsed} vs n_tokens ${L.nTokens}`)
  check('/metrics counters agree (single request)', tasks.length !== 1 || (dPrompt === L.promptN && dPred === L.evalN), `Δprompt_tokens_total ${dPrompt}, Δtokens_predicted_total ${dPred}, Δcached ${dCached}`)

  report.push(
    '# LocalForge stats verification',
    '',
    `Run: ${new Date().toISOString()} · app: ${dev ? 'dev build' : appPath} · prompt ~${targetTokens} tokens (uncached)`,
    '',
    '| Quantity | LocalForge UI | llama-server (log / metrics) | Match |',
    '|---|---|---|---|',
    `| Prompt tokens processed | ${ui.raw.prompt_n} | ${L.promptN} (Δmetrics ${dPrompt}) | ${ui.raw.prompt_n === L.promptN ? '✅' : '❌'} |`,
    `| Prompt tokens cached | ${ui.raw.cache_n} | Δmetrics ${dCached} | ${tasks.length !== 1 || ui.raw.cache_n === dCached ? '✅' : '❌'} |`,
    `| Output tokens | ${ui.output} | ${L.evalN} (Δmetrics ${dPred}) | ${ui.output === L.evalN ? '✅' : '❌'} |`,
    `| Prompt processing speed | ${ui.ppTps} t/s (${ui.raw.prompt_per_second.toFixed(2)}) | ${L.promptTps} t/s | ${ui.ppTps === fmt1(L.promptTps!) ? '✅' : '❌'} |`,
    `| Generation speed | ${ui.genTps} t/s (${ui.raw.predicted_per_second.toFixed(2)}) | ${L.evalTps} t/s | ${ui.genTps === fmt1(L.evalTps!) ? '✅' : '❌'} |`,
    `| Prompt time | ${ui.raw.prompt_ms} ms | ${L.promptMs} ms | ${Math.abs(ui.raw.prompt_ms - L.promptMs!) < 0.01 ? '✅' : '❌'} |`,
    `| Generation time | ${ui.raw.predicted_ms} ms | ${L.evalMs} ms | ${Math.abs(ui.raw.predicted_ms - L.evalMs!) < 0.01 ? '✅' : '❌'} |`,
    `| Context used | ${ui.contextUsed} | n_tokens ${L.nTokens} (+1 final token) | ${ui.contextUsed === (L.nTokens ?? -2) + 1 ? '✅' : '❌'} |`,
    `| Thinking tokens (LocalForge count) | ${ui.thinking} | (not reported by llama-server) | – |`,
    '',
    `Prompt progress on screen: ${uiPct.join(' → ')}%`,
    `Server progress updates (processed tokens): ${serverProcessed.join(' → ')}`,
    '',
    ...results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`),
  )
} catch (e) {
  check('no unexpected error', false, e instanceof Error ? e.stack : String(e))
  await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {})
} finally {
  writeFileSync(path.join(outDir, 'report.md'), report.join('\n') + '\n')
  if (projectId && !keep) await page.evaluate((id) => (window as unknown as { lf: { call: (m: string, ...a: unknown[]) => Promise<unknown> } }).lf.call('removeProject', id, true), projectId).catch(() => {})
  await app.close().catch(() => {})
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  for (const x of failed) console.log('  FAILED:', x.name, x.detail ?? '')
  process.exit(failed.length ? 1 : 0)
}
