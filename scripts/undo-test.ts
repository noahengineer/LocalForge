// Verify auto-checkpoints and "Undo to checkpoint" with real agent turns.
// Usage: npx tsx scripts/undo-test.ts <projectId>
import { Backend } from '../src/main/backend/backend'
import type { Checkpoint } from '../src/shared/api'

const [projectId] = process.argv.slice(2)
const backend = new Backend()
await backend.init({ hardware: false, polling: false })
await backend.connect(projectId)
const session = await backend.createSession(projectId, 'undo test')
const checkpoints: Checkpoint[] = []
let idleResolve: (() => void) | null = null
backend.on('event', (ev) => {
  if (ev.type === 'checkpoint' && ev.projectId === projectId) {
    checkpoints.push(ev.checkpoint)
    console.log('checkpoint', ev.checkpoint.shortCommit, ev.checkpoint.subject)
  }
  if (ev.type === 'oc' && ev.event.type === 'session.idle' && ev.event.properties.sessionID === session.id) idleResolve?.()
})
async function turn(text: string) {
  const idle = new Promise<void>((r) => (idleResolve = r))
  await backend.prompt({ projectId, sessionId: session.id, agent: 'build', text })
  await idle
  await new Promise((r) => setTimeout(r, 4000)) // checkpoint is committed right after idle
}
const read = async () => (await backend.sandboxes.sh(projectId, 'cat /workspace/notes.txt 2>/dev/null || echo "<missing>"')).trim()

await turn('Create a file notes.txt in the project root containing exactly the single line ONE. Use the write tool. Do not do anything else.')
const afterOne = await read()
await turn('Append a second line TWO to notes.txt (so it has the lines ONE and TWO). Do not do anything else.')
const afterTwo = await read()
const listed = await backend.listCheckpoints(projectId)
const cp1 = checkpoints[0]
await backend.undoToCheckpoint(projectId, session.id, cp1.commit)
const afterUndo = await read()
const sess = (await backend.listSessions(projectId)).find((s) => s.id === session.id)
const msgs = await backend.getMessages(projectId, session.id)
const users = msgs.filter((m) => m.info.role === 'user')
const result = {
  checkpointsCreated: checkpoints.length,
  listedCheckpoints: listed.slice(0, 3).map((c) => c.subject),
  afterOne,
  afterTwo,
  afterUndo,
  revertSetAtSecondTurn: !!sess?.revert && sess.revert.messageID === users[1]?.info.id,
}
console.log(JSON.stringify(result, null, 2))
const ok = checkpoints.length >= 2 && afterOne === 'ONE' && /ONE\s+TWO/.test(afterTwo) && afterUndo === 'ONE' && result.revertSetAtSecondTurn
console.log(ok ? 'UNDO OK' : 'UNDO FAILED')
await backend.shutdown()
process.exit(ok ? 0 : 1)
