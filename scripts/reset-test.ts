// Verify "Reset sandbox": the container is recreated from the current image, project files and
// chat sessions survive, and container-only state (a file outside /workspace) is gone.
// Usage: npx tsx scripts/reset-test.ts <projectId>
import { Backend } from '../src/main/backend/backend'

const [projectId] = process.argv.slice(2)
const backend = new Backend()
await backend.init({ hardware: false, polling: false })
await backend.connect(projectId)
const sh = (s: string) => backend.sandboxes.sh(projectId, s)
const before = (await backend.podman.run(['container', 'inspect', '--format', '{{.Id}} {{.ImageName}}', `localforge-${projectId}`])).stdout.trim()
await sh('echo marker > /home/dev/container-only.txt && date > /workspace/.reset-marker')
const sessionsBefore = (await backend.listSessions(projectId)).map((s) => s.id).sort()
await backend.resetSandbox(projectId)
const after = (await backend.podman.run(['container', 'inspect', '--format', '{{.Id}} {{.ImageName}}', `localforge-${projectId}`])).stdout.trim()
const sessionsAfter = (await backend.listSessions(projectId)).map((s) => s.id).sort()
const containerFile = (await sh('test -e /home/dev/container-only.txt && echo present || echo gone')).trim()
const workspaceFile = (await sh('test -e /workspace/.reset-marker && echo present || echo gone')).trim()
const skill = (await sh('test -f ~/.config/opencode/skills/graphify/SKILL.md && echo yes || echo no')).trim()
await sh('rm -f /workspace/.reset-marker')
const result = {
  newContainer: before.split(' ')[0] !== after.split(' ')[0],
  imageBefore: before.split(' ')[1],
  imageAfter: after.split(' ')[1],
  sessionsKept: JSON.stringify(sessionsBefore) === JSON.stringify(sessionsAfter) && sessionsBefore.length > 0,
  containerOnlyFile: containerFile,
  workspaceFile,
  graphifySkillReinstalled: skill,
}
console.log(JSON.stringify(result, null, 2))
const ok = result.newContainer && result.sessionsKept && containerFile === 'gone' && workspaceFile === 'present' && skill === 'yes'
console.log(ok ? 'RESET OK' : 'RESET FAILED')
await backend.shutdown()
process.exit(ok ? 0 : 1)
