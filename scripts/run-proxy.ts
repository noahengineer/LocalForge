// Dev helper: run the LocalForge stats proxy standalone and log every request's final stats.
// Usage: npx tsx scripts/run-proxy.ts [port] [upstream]
import { appendFileSync } from 'node:fs'
import { StatsProxy } from '../src/main/backend/stats/proxy'

const port = Number(process.argv[2] ?? 8081)
const upstream = process.argv[3] ?? 'http://127.0.0.1:8080'
const logFile = process.env.PROXY_LOG
const proxy = new StatsProxy({ port, upstream })
proxy.on('start', (s) => console.log(`[start] ${s.id} project=${s.projectId} kind=${s.kind} msgs=${s.messageCount} tools=${s.hasTools}`))
proxy.on('end', (s) => {
  console.log(
    `[end] ${s.id} ${s.phase} http=${s.httpStatus} prompt=${s.promptTotal}(cached ${s.promptCached}) ` +
      `pp=${s.promptPerSecond?.toFixed(1)}t/s gen=${s.predictedN} (reasoning ${s.reasoningTokens}, content ${s.contentTokens}, tool ${s.toolTokens}) ` +
      `tg=${s.predictedPerSecond?.toFixed(2)}t/s toolCalls=${s.toolCalls} ttft=${s.firstTokenAt ? s.firstTokenAt - s.startedAt : null}ms ` +
      `total=${(s.endedAt ?? 0) - s.startedAt}ms usage=${JSON.stringify(s.usage)}`,
  )
  if (logFile) appendFileSync(logFile, JSON.stringify(s) + '\n')
})
await proxy.start()
console.log(`stats proxy listening on 127.0.0.1:${proxy.port} -> ${upstream}`)
