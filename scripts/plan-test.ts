// Verify: creating a project with a description opens a session in Plan mode with it, and Plan
// mode does not modify project files. Usage: npx tsx scripts/plan-test.ts [--keep]
import { Backend } from '../src/main/backend/backend'

const backend = new Backend()
await backend.init({ hardware: false, polling: false })
const description = 'A command-line tool that converts temperatures between Celsius and Fahrenheit.'
let sessionId: string | null = null
let projectId: string | null = null
const answered: string[] = []
const idle = new Promise<void>((resolve) => {
  backend.on('event', (ev) => {
    // Plan mode may ask clarifying questions (OpenCode's question tool): answer like a user clicking
    // the first option on the question card.
    if (ev.type === 'oc' && ev.event.type === 'question.asked' && projectId) {
      const q = ev.event.properties as { id: string; questions: Array<{ question: string; options?: Array<{ label: string }> }> }
      const answers = q.questions.map((x) => [x.options?.[0]?.label ?? 'Use your best judgement'])
      answered.push(...q.questions.map((x, i) => `${x.question} -> ${answers[i][0]}`))
      console.log('question', JSON.stringify(answers))
      void backend.replyQuestion(projectId, q.id, answers)
    }
    if (ev.type === 'oc' && ev.event.type === 'session.idle' && ev.event.properties.sessionID === sessionId) resolve()
    if (ev.type === 'oc' && ev.event.type === 'message.part.updated' && ev.event.properties.part?.type === 'tool' && ev.event.properties.part.state?.status === 'completed')
      console.log('tool', ev.event.properties.part.tool, JSON.stringify(ev.event.properties.part.state.input).slice(0, 120))
  })
})
const name = `plan-test-${Date.now().toString(36).slice(-4)}`
// The plan prompt starts inside createProject, so learn the ids from the progress events.
backend.on('event', (ev) => {
  if (ev.type === 'create-progress') {
    projectId = ev.progress.projectId ?? projectId
  }
  if (ev.type === 'oc' && !sessionId && ev.event.type === 'session.status') sessionId = ev.event.properties.sessionID
})
const r = await backend.createProject({ name, template: 'python', description })
sessionId = r.sessionId
projectId = r.projectId
console.log('created', r)
await idle
const msgs = await backend.getMessages(r.projectId, r.sessionId!)
const firstUser = msgs.find((m) => m.info.role === 'user')
const answer = [...msgs].reverse().find((m) => m.info.role === 'assistant')?.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') ?? ''
const status = (await backend.sandboxes.sh(r.projectId, 'git status --porcelain -- . ":!.opencode" | head -20')).trim()
const result = {
  firstPromptIsDescription: firstUser?.parts.some((p) => p.type === 'text' && p.text === description),
  agent: firstUser?.info.agent,
  filesUnchanged: status === '',
  gitStatus: status,
  answerPreview: answer.replace(/\s+/g, ' ').slice(0, 300),
  questionsAnswered: answered,
}
console.log(JSON.stringify(result, null, 2))
const ok = result.firstPromptIsDescription && result.agent === 'plan' && result.filesUnchanged && answer.length > 50
console.log(ok ? 'PLAN OK' : 'PLAN FAILED')
if (!process.argv.includes('--keep')) await backend.removeProject(r.projectId, true)
await backend.shutdown()
process.exit(ok ? 0 : 1)
