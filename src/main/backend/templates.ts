import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TemplateId, TemplateInfo } from '../../shared/api'
import { templatesDir } from './paths'

export interface TemplateManifest extends TemplateInfo {
  notes?: string
}

export const TEMPLATE_ORDER: TemplateId[] = ['empty', 'cpp', 'react-ts', 'node', 'python', 'rust', 'electron']

/** Files whose leading underscore is a packaging convention for a dotfile. */
const RENAMES: Record<string, string> = { _gitignore: '.gitignore', '_oxlintrc.json': '.oxlintrc.json' }

const TEXT_EXT = new Set(['.json', '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.css', '.cpp', '.hpp', '.h', '.c', '.py', '.rs', '.toml', '.yml', '.yaml', '.svg', ''])

export interface TemplateVars {
  name: string
  slug: string
  cident: string
  pyident: string
  description: string
}

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'project'
}

export function identOf(name: string): string {
  let s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!s) s = 'app'
  if (/^[0-9]/.test(s)) s = 'app_' + s
  return s
}

export function templateVars(name: string, description: string): TemplateVars {
  return { name, slug: slugify(name), cident: identOf(name), pyident: identOf(name), description: description.trim() || 'Created with LocalForge.' }
}

export function substitute(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{(name|slug|cident|pyident|description)\}\}/g, (_, k: keyof TemplateVars) => vars[k])
}

export function loadTemplates(dir = templatesDir()): TemplateManifest[] {
  const out: TemplateManifest[] = []
  for (const id of TEMPLATE_ORDER) {
    const f = path.join(dir, id, 'template.json')
    if (!existsSync(f)) continue
    out.push(JSON.parse(readFileSync(f, 'utf8')) as TemplateManifest)
  }
  return out
}

export function getTemplate(id: TemplateId, dir = templatesDir()): TemplateManifest {
  const t = loadTemplates(dir).find((x) => x.id === id)
  if (!t) throw new Error(`unknown template: ${id}`)
  return t
}

/** Copy a template's files into `dest`, substituting variables in text files and paths. */
export function scaffold(id: TemplateId, dest: string, vars: TemplateVars, dir = templatesDir()): string[] {
  const src = path.join(dir, id, 'files')
  const written: string[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(src, rel)).sort()) {
      const srcRel = path.join(rel, name)
      const st = statSync(path.join(src, srcRel))
      const outName = substitute(RENAMES[name] ?? name, vars)
      const outRel = path.join(substitute(rel, vars), outName)
      if (st.isDirectory()) {
        mkdirSync(path.join(dest, outRel), { recursive: true })
        walk(srcRel)
        continue
      }
      mkdirSync(path.dirname(path.join(dest, outRel)), { recursive: true })
      const ext = path.extname(name).toLowerCase()
      if (TEXT_EXT.has(ext) || name in RENAMES) {
        writeFileSync(path.join(dest, outRel), substitute(readFileSync(path.join(src, srcRel), 'utf8'), vars))
      } else {
        copyFileSync(path.join(src, srcRel), path.join(dest, outRel))
      }
      written.push(outRel)
    }
  }
  walk('')
  return written
}

export const GLOBAL_RULES = [
  'Always read a file before editing it. Never guess file paths; list or search first.',
  'Make small, focused changes, one feature or fix at a time.',
  'After every change, run the build/test command and fix errors before continuing.',
  'If a tool call fails, re-read the error and retry correctly.',
  "Before using a library/API you're unsure about, search for or fetch its current docs.",
  'To test GUI apps, run them and verify with screenshots; for web apps, use Playwright.',
]

const rulesSection = () => `## Rules

${GLOBAL_RULES.map((r) => `- ${r}`).join('\n')}
`

/** The sandbox description shared by every project's instructions. */
export function environmentSection(opts: { graph: boolean; checkpoints: boolean }): string {
  return `## Environment

You are working inside an isolated Linux sandbox (Ubuntu container). It cannot harm the user's
computer, so you can install packages and run anything you need.

- The project is at \`/workspace\` (the current directory). Only this folder is shared with the user.
- You are user \`dev\` with passwordless \`sudo\` (e.g. \`sudo apt-get install -y <pkg>\`).
- Toolchains: gcc/g++, clang, cmake, ninja, gdb, vcpkg (\`$VCPKG_ROOT=/opt/vcpkg\`), Node.js + npm,
  Python 3 (+ venv, pip, pipx), Rust (cargo, rustfmt, clippy), git. Internet access is available.
- You have your own desktop (XFCE on display \`:1\`). GUI apps you start appear there and the user
  can watch it live. Use the \`computer_*\` tools to see it (\`computer_screenshot\`) and to click,
  type, press keys and scroll; use \`computer_launch_app\` to start GUI programs in the background.
- For web pages and web apps prefer the \`playwright_*\` browser tools (navigate, snapshot, click,
  type, screenshot) over pixel clicking. The browser opens on your desktop.
- Long-running servers must run in the background (\`cmd > /tmp/server.log 2>&1 &\`) so the shell
  tool doesn't block; then check them with \`curl\` or the browser tools.
${
  opts.graph
    ? `- \`graphify\` keeps a code knowledge graph in \`graphify-out/\`; run \`graphify query "<question>"\` for
  focused questions about the codebase and \`graphify update .\` after large changes.
`
    : ''
}${opts.checkpoints ? "- The user's app takes a git checkpoint after each of your turns; don't rewrite git history.\n" : ''}`
}

const commandList = (c: { setup?: string; build?: string; test?: string; run?: string; dev?: string }, sub: (s: string) => string = (x) => x) => {
  const cmd = (label: string, v?: string) => (v ? `- **${label}:** \`${sub(v)}\`\n` : '')
  return cmd('Setup', c.setup) + cmd('Build', c.build) + cmd('Test', c.test) + cmd('Run', c.run) + cmd('Dev server', c.dev)
}

/** AGENTS.md content: global rules + sandbox environment + template-specific commands. */
export function agentsMd(t: TemplateManifest, vars: TemplateVars): string {
  const commands = commandList(t.commands, (v) => substitute(v, vars))
  return `# ${vars.name}: agent instructions

${vars.description}

${rulesSection()}
## Project commands (${t.name})

${commands || '- No build system yet.\n'}
${t.notes ? substitute(t.notes, vars) + '\n' : ''}
${environmentSection({ graph: true, checkpoints: true })}`
}

/**
 * Instructions for an existing folder opened in place. Written as the project's AGENTS.md when it
 * has no instructions file of its own, otherwise into the sandbox's global AGENTS.md (the user's
 * own AGENTS.md/CLAUDE.md is left untouched and still applies).
 */
export function importedAgentsMd(opts: {
  name: string
  description: string
  stack: { kinds: string[]; commands: { setup?: string; build?: string; test?: string; run?: string }; notes: string[] }
  ownInstructionsFile: string | null
  graph: boolean
  checkpoints: boolean
}): string {
  const s = opts.stack
  const detected = commandList(s.commands)
  const intro = opts.ownInstructionsFile
    ? `These are the LocalForge sandbox rules. The project's own \`${opts.ownInstructionsFile}\` also applies and takes precedence for project conventions.`
    : 'This is an existing project that was opened in LocalForge.'
  return `# ${opts.name}: agent instructions

${intro}
${opts.description ? `\n${opts.description}\n` : ''}
This code already existed before you started. Before changing anything, explore it: read the README
and the build files, list the source tree, and run the existing build/tests to see the current state.

${rulesSection()}
## Project commands

${s.kinds.length ? `Detected stack: ${s.kinds.join(', ')}.\n` : 'The stack was not detected automatically.\n'}
${detected ? `Detected commands (guessed from the files; verify them before relying on them):\n\n${detected}` : ''}
${s.notes.map((n) => `- ${n}`).join('\n')}${s.notes.length ? '\n' : ''}
When you have confirmed how to build, test and run this project, ${opts.ownInstructionsFile ? 'tell the user' : 'update this section with the real commands'}.

${environmentSection({ graph: opts.graph, checkpoints: opts.checkpoints })}`
}
