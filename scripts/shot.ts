// Dev helper: launch the built app (out/) with Playwright-for-Electron and save screenshots.
// Usage: npx tsx scripts/shot.ts <outDir> [waitSeconds] [tab]
import { _electron as electron } from 'playwright'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const outDir = process.argv[2] ?? '/tmp'
const wait = Number(process.argv[3] ?? 20)
const tab = process.argv[4]
mkdirSync(outDir, { recursive: true })
const app = await electron.launch({
  args: [path.resolve('out/main/index.js')],
  env: { ...(process.env as Record<string, string>), ELECTRON_ENABLE_LOGGING: '1' },
})
const page = await app.firstWindow()
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer ${m.type()}]`, m.text().slice(0, 400))
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.setViewportSize({ width: 1480, height: 920 }).catch(() => {})
await page.waitForTimeout(wait * 1000)
if (tab) await page.click(`[data-testid="tab-${tab}"]`).catch(() => {})
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(outDir, `app-${tab ?? 'main'}.png`) })
console.log('saved', path.join(outDir, `app-${tab ?? 'main'}.png`))
await app.close()
