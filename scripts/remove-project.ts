// Dev helper: remove a project (container, state volume, registry entry; --files also trashes its folder).
// Usage: npx tsx scripts/remove-project.ts <projectId|all-matching-prefix> [--files]
import { Backend } from '../src/main/backend/backend'

const [target, flag] = process.argv.slice(2)
const backend = new Backend()
const matches = backend.listProjects().filter((p) => p.id === target || (target.endsWith('*') && p.id.startsWith(target.slice(0, -1))))
if (matches.length === 0) console.log('no matching projects:', backend.listProjects().map((p) => p.id).join(', '))
for (const p of matches) {
  await backend.removeProject(p.id, flag === '--files')
  console.log('removed', p.id, p.path, flag === '--files' ? '(files trashed)' : '')
}
process.exit(0)
