// Experiment: does the model click accurately with the computer-use tools?
// Asks the agent to open the desktop's Terminal icon and checks a terminal window really appeared.
// Usage: npx tsx scripts/click-test.ts <projectId> [pixels|norm1000]
import { Backend } from '../src/main/backend/backend'

const [projectId, mode = 'pixels'] = process.argv.slice(2)
const backend = new Backend()
await backend.init({ hardware: false, polling: false })
if (backend.getSettings().sandbox.computerUseCoords !== mode) backend.updateSettings({ sandbox: { computerUseCoords: mode as 'pixels' | 'norm1000' } })
const conn = await backend.connect(projectId)
await backend.sandboxes.writeOpenCodeConfig(projectId, await backend.openCodeConfigFor(backend.projects.get(projectId)))
await conn.waitHealthy()
const countTerms = async () =>
  Number((await backend.sandboxes.sh(projectId, 'DISPLAY=:1 xdotool search --onlyvisible --class xfce4-terminal 2>/dev/null | wc -l')).trim())
await backend.sandboxes.sh(projectId, 'pkill -x xfce4-terminal; true')
const before = await countTerms()
const session = await backend.createSession(projectId, `click test (${mode})`)
let done!: () => void
const idle = new Promise<void>((r) => (done = r))
backend.on('event', (ev) => {
  if (ev.type === 'oc' && ev.event.type === 'session.idle' && ev.event.properties.sessionID === session.id) done()
  if (ev.type === 'oc' && ev.event.type === 'message.part.updated' && ev.event.properties.part?.type === 'tool' && ev.event.properties.part.state?.status === 'completed')
    console.log('tool', ev.event.properties.part.tool, JSON.stringify(ev.event.properties.part.state.input))
})
await backend.prompt({
  projectId,
  sessionId: session.id,
  agent: 'build',
  text: 'Take a screenshot of your desktop, then open the "Terminal" icon on the desktop by double-clicking it with the computer_double_click tool. Then take another screenshot to check that a terminal window opened, and reply with OPENED or NOT OPENED.',
})
await idle
await new Promise((r) => setTimeout(r, 1500))
const after = await countTerms()
const msgs = await backend.getMessages(projectId, session.id)
const answer = [...msgs].reverse().find((m) => m.info.role === 'assistant')?.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ')
console.log(JSON.stringify({ mode, terminalsBefore: before, terminalsAfter: after, opened: after > before, answer }))
await backend.shutdown()
process.exit(0)
