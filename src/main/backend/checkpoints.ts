import type { ChangesInfo, Checkpoint } from '../../shared/api'

/**
 * Git checkpoints. All git commands run INSIDE the sandbox: the repository is writable by the
 * agent, and running the host's git on it would execute agent-controlled hooks/config
 * (core.hooksPath, core.fsmonitor, filters...) on the host.
 */
export type Sh = (script: string, timeoutMs?: number) => Promise<string>

export const SESSION_TRAILER = 'LocalForge-Session'
export const MESSAGE_TRAILER = 'LocalForge-Message'

/** Single-quote a string for bash. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const GIT = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false'

export function checkpointSubject(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  const short = oneLine.length > 60 ? oneLine.slice(0, 57) + '...' : oneLine
  return `Checkpoint: ${short || 'agent turn'}`
}

/** Commit all changes as a checkpoint. Returns the checkpoint, or null when nothing changed. */
export async function commitCheckpoint(sh: Sh, opts: { subject: string; sessionId: string | null; messageId: string | null }): Promise<Checkpoint | null> {
  const body = [opts.sessionId ? `${SESSION_TRAILER}: ${opts.sessionId}` : '', opts.messageId ? `${MESSAGE_TRAILER}: ${opts.messageId}` : '']
    .filter(Boolean)
    .join('\n')
  const out = await sh(
    `cd /workspace && ${GIT} add -A && if ${GIT} diff --cached --quiet; then echo NOCHANGE; else ` +
      `${GIT} commit -q --no-verify -m ${shq(opts.subject)} -m ${shq(body || 'LocalForge checkpoint')} && ${GIT} log -1 --format='%H%x1f%h%x1f%s%x1f%ct'; fi`,
  )
  const line = out.trim().split('\n').pop() ?? ''
  if (line === 'NOCHANGE' || !line.includes('\x1f')) return null
  const [commit, shortCommit, subject, ct] = line.split('\x1f')
  return { commit, shortCommit, subject, time: Number(ct) * 1000, sessionId: opts.sessionId, messageId: opts.messageId }
}

/** Parse `git log --format=%H%x1f%h%x1f%s%x1f%ct%x1f%b%x1e`. */
export function parseLog(out: string): Checkpoint[] {
  const res: Checkpoint[] = []
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\n+/, '')
    if (!r.trim()) continue
    const [commit, shortCommit, subject, ct, body = ''] = r.split('\x1f')
    const sid = new RegExp(`^${SESSION_TRAILER}: (\\S+)`, 'm').exec(body)?.[1] ?? null
    const mid = new RegExp(`^${MESSAGE_TRAILER}: (\\S+)`, 'm').exec(body)?.[1] ?? null
    res.push({ commit, shortCommit, subject, time: Number(ct) * 1000, sessionId: sid, messageId: mid })
  }
  return res
}

/**
 * Checkpoints on the current branch (newest first), ending with the project's base commit (the
 * initial commit of a new project, or HEAD when an existing folder was imported). Commits older
 * than the base (an imported repository's own history) are never offered for Undo. Without a known
 * base (legacy projects) the root commit is used.
 */
export async function listCheckpoints(sh: Sh, opts: { base?: string | null; limit?: number } = {}): Promise<Checkpoint[]> {
  const out = await sh(`cd /workspace && ${GIT} log -n ${opts.limit ?? 300} --format='%H%x1f%h%x1f%s%x1f%ct%x1f%b%x1e' 2>/dev/null || true`)
  return selectCheckpoints(parseLog(out), opts.base)
}

export function selectCheckpoints(all: Checkpoint[], base?: string | null): Checkpoint[] {
  if (base === undefined) return all.filter((c, i) => c.sessionId !== null || i === all.length - 1)
  const idx = base ? all.findIndex((c) => c.commit === base) : -1
  const upto = idx >= 0 ? all.slice(0, idx + 1) : all
  return upto.filter((c) => c.sessionId !== null || (idx >= 0 && c.commit === base))
}

/** HEAD commit of the project repository (inside the sandbox), or null. */
export async function headCommit(sh: Sh): Promise<string | null> {
  const out = (await sh(`cd /workspace && ${GIT} rev-parse -q --verify HEAD 2>/dev/null || true`)).trim()
  return /^[0-9a-f]{40}$/.test(out) ? out : null
}

/** Restore files to a checkpoint: tracked files reset, untracked (non-ignored) files removed. */
export async function resetTo(sh: Sh, commit: string): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('invalid commit id')
  await sh(`cd /workspace && ${GIT} reset -q --hard ${commit} && ${GIT} clean -q -fd`)
}

const MAX_DIFF = 1_500_000

/** Uncommitted changes since the last checkpoint (HEAD), including untracked files. */
export async function changes(sh: Sh): Promise<ChangesInfo> {
  // A throwaway index keeps the agent's real index untouched.
  const script =
    `cd /workspace && export GIT_INDEX_FILE=$(mktemp -u /tmp/lf-index.XXXXXX) && ` +
    `trap 'rm -f "$GIT_INDEX_FILE"' EXIT && ` +
    `if ${GIT} rev-parse -q --verify HEAD >/dev/null; then ${GIT} read-tree HEAD; BASE=HEAD; else BASE=$(${GIT} hash-object -t tree /dev/null); fi && ` +
    `${GIT} add -A >/dev/null 2>&1; ` +
    `echo "@@BASE $(${GIT} log -1 --format='%H%x1f%s' 2>/dev/null)"; ` +
    `echo "@@NUMSTAT"; ${GIT} diff --cached --numstat $BASE; ` +
    `echo "@@STATUS"; ${GIT} diff --cached --name-status $BASE; ` +
    `echo "@@DIFF"; ${GIT} diff --cached --no-color $BASE | head -c ${MAX_DIFF}`
  const out = await sh(script, 60_000)
  return parseChanges(out)
}

export function parseChanges(out: string): ChangesInfo {
  const sec = (name: string, next?: string) => {
    const start = out.indexOf(`@@${name}`)
    if (start < 0) return ''
    const from = out.indexOf('\n', start) + 1
    const end = next ? out.indexOf(`@@${next}`, from) : -1
    return end < 0 ? out.slice(from) : out.slice(from, end)
  }
  const baseLine = /@@BASE (.*)/.exec(out)?.[1] ?? ''
  const [baseCommit, baseSubject] = baseLine.includes('\x1f') ? baseLine.split('\x1f') : [null, null]
  const numstat = new Map<string, { add: number; del: number }>()
  for (const l of sec('NUMSTAT', 'STATUS').split('\n')) {
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(l)
    if (m) numstat.set(m[3], { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) })
  }
  const files: ChangesInfo['files'] = []
  for (const l of sec('STATUS', 'DIFF').split('\n')) {
    const m = /^([A-Z])\S*\t(.+)$/.exec(l)
    if (!m) continue
    const p = m[2].split('\t').pop()!
    const ns = numstat.get(p) ?? { add: 0, del: 0 }
    files.push({ path: p, status: m[1], additions: ns.add, deletions: ns.del })
  }
  return { baseCommit: baseCommit || null, baseSubject: baseSubject || null, files, diff: sec('DIFF') }
}
