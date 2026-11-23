// Dev helper: create a project through the real Backend and print progress.
// Usage: npx tsx scripts/try-create.ts <name> <template> ["description"]
import { Backend } from '../src/main/backend/backend'
import type { TemplateId } from '../src/shared/api'

const [name, template = 'cpp', description = ''] = process.argv.slice(2)
const backend = new Backend()
let last = ''
backend.on('event', (ev) => {
  if (ev.type === 'create-progress') {
    const line = ev.progress.steps.map((s) => `${s.id}:${s.status}`).join(' ')
    if (line !== last) {
      last = line
      const running = ev.progress.steps.find((s) => s.status === 'running' || s.status === 'error')
      console.log(new Date().toISOString().slice(11, 19), line, running?.detail ? `| ${running.detail.slice(0, 300)}` : '')
    }
  } else if (ev.type === 'image-build' && ev.state.status === 'building' && ev.state.stepText) {
    // keep quiet; step changes are enough
  } else if (ev.type === 'toast') console.log('TOAST', ev.level, ev.message)
})
await backend.init({ hardware: false, polling: false })
const t0 = Date.now()
try {
  const r = await backend.createProject({ name, template: template as TemplateId, description })
  console.log('CREATED', r, `${((Date.now() - t0) / 1000).toFixed(1)}s`)
} catch (e) {
  console.error('FAILED', e)
}
await backend.shutdown()
process.exit(0)
