// Dev helper: drive an OpenCode server (inside a sandbox) through the v2 SDK and summarize events.
// Usage: npx tsx scripts/oc-smoke.ts <baseUrl> <password> "<prompt>" [agent]
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

const [baseUrl, password, prompt, agent = 'build'] = process.argv.slice(2)
const client = createOpencodeClient({
  baseUrl,
  directory: '/workspace',
  headers: { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') },
})

const t0 = Date.now()
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's'
const session = (await client.session.create({ title: 'smoke' })).data!
console.log(ts(), 'session', session.id)

const events = await client.event.subscribe()
const counts: Record<string, number> = {}
let done = false
const loop = (async () => {
  for await (const ev of events.stream as AsyncIterable<{ type: string; properties: any }>) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1
    const p = ev.properties
    if (p?.sessionID && p.sessionID !== session.id && !(p.part && p.part.sessionID === session.id) && !(p.info && p.info.sessionID === session.id)) continue
    switch (ev.type) {
      case 'message.updated':
        console.log(ts(), 'message.updated', p.info.role, p.info.id, 'completed=', !!p.info.time?.completed, 'tokens=', JSON.stringify(p.info.tokens ?? null), p.info.finish ?? '')
        break
      case 'message.part.updated': {
        const part = p.part
        if (part.type === 'tool') console.log(ts(), 'part tool', part.tool, part.state.status, JSON.stringify(part.state.input).slice(0, 120), part.state.status === 'completed' ? `-> ${String(part.state.output).slice(0, 160).replace(/\n/g, '\\n')} meta=${Object.keys(part.state.metadata ?? {}).join(',')} att=${part.state.attachments?.length ?? 0}` : '')
        else if (part.type === 'step-finish') console.log(ts(), 'part step-finish', part.reason, JSON.stringify(part.tokens))
        else if (part.type === 'text' || part.type === 'reasoning') {
          if (part.time?.end) console.log(ts(), `part ${part.type} END len=${part.text.length}: ${part.text.slice(0, 200).replace(/\n/g, '\\n')}`)
        } else console.log(ts(), 'part', part.type)
        break
      }
      case 'message.part.delta':
        break
      case 'session.status':
        console.log(ts(), 'status', JSON.stringify(p.status))
        break
      case 'session.idle':
        console.log(ts(), 'IDLE')
        done = true
        return
      case 'session.error':
        console.log(ts(), 'ERROR', JSON.stringify(p.error))
        break
      case 'permission.asked':
        console.log(ts(), 'PERMISSION', JSON.stringify(p))
        break
      default:
        if (!ev.type.startsWith('session.next')) console.log(ts(), ev.type)
    }
  }
})()

const r = await client.session.promptAsync({ sessionID: session.id, agent, parts: [{ type: 'text', text: prompt }] })
console.log(ts(), 'promptAsync ->', r.response?.status)
const timeout = setTimeout(() => {
  console.log('TIMEOUT')
  process.exit(2)
}, 30 * 60 * 1000)
await loop
clearTimeout(timeout)
console.log('event counts', counts)
const msgs = (await client.session.messages({ sessionID: session.id })).data!
for (const m of msgs) console.log('MSG', m.info.role, m.info.id, m.parts.map((x: any) => x.type).join(','))
process.exit(done ? 0 : 1)
