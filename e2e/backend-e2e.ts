/**
 * Backend end-to-end test, driven through the app's own Backend class (the same code the Electron
 * main process runs). Needs llama-server running and podman.
 *
 *   npx tsx e2e/backend-e2e.ts [--keep]
 *
 * 1. creates a C++ project (template + sandbox + OpenCode + graphify + initial commit);
 * 2. asks the agent "create a hello world program with CMake, build it and run it", waits for
 *    completion, then verifies a binary exists in /workspace and prints the expected output;
 * 3. verifies the computer-use screenshot tool returns a real PNG, and that the model can describe it;
 * 4. verifies web search and web fetch work from inside the sandbox;
 * 5. verifies the container cannot see the user's home folder (and only reaches the stats proxy).
 * Results: e2e/output/backend/report.json (+ screenshot.png).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Backend } from '../src/main/backend/backend'
import type { OcMessage } from '../src/shared/api'

const keep = process.argv.includes('--keep')
const outDir = path.resolve('e2e/output/backend')
mkdirSync(outDir, { recursive: true })
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...a)
const results: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail })
  log(ok ? 'PASS' : 'FAIL', name, detail ? `| ${detail.slice(0, 400)}` : '')
}

const backend = new Backend()
const idle = new Map<string, () => void>()
backend.on('event', (ev) => {
  if (ev.type === 'oc') {
    const p = ev.event.properties ?? {}
    if (ev.event.type === 'session.idle' && idle.has(p.sessionID)) idle.get(p.sessionID)!()
    if (ev.event.type === 'message.part.updated' && p.part?.type === 'tool' && (p.part.state?.status === 'completed' || p.part.state?.status === 'error')) {
      const st = p.part.state
      log(`  tool ${p.part.tool} ${st.status}: ${JSON.stringify(st.input).slice(0, 140)}`)
    }
  } else if (ev.type === 'llm-end') {
    const s = ev.stats
    log(`  llm ${s.kind} ${s.phase}: prompt ${s.promptTotal} (cached ${s.promptCached}) pp ${s.promptPerSecond?.toFixed(0)} t/s, gen ${s.predictedN} tok (${s.reasoningTokens} thinking) at ${s.predictedPerSecond?.toFixed(2)} t/s`)
  } else if (ev.type === 'toast' && ev.level === 'error') log('  TOAST', ev.message)
})

/** Send a prompt and wait until the session is idle again. */
async function ask(projectId: string, sessionId: string, text: string, timeoutMs = 45 * 60_000): Promise<OcMessage[]> {
  log('ASK:', text)
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the agent')), timeoutMs)
    idle.set(sessionId, () => {
      clearTimeout(timer)
      idle.delete(sessionId)
      resolve()
    })
  })
  await backend.prompt({ projectId, sessionId, text, agent: 'build' })
  await done
  const msgs = await backend.getMessages(projectId, sessionId)
  const last = [...msgs].reverse().find((m) => m.info.role === 'assistant')
  const answer = last?.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') ?? ''
  log('ANSWER:', answer.replace(/\s+/g, ' ').slice(0, 600))
  return msgs
}

function toolParts(msgs: OcMessage[], since: number): Array<Record<string, any>> {
  return msgs.filter((m) => m.info.time?.created >= since).flatMap((m) => m.parts.filter((p) => p.type === 'tool'))
}
function lastAnswer(msgs: OcMessage[]): string {
  const last = [...msgs].reverse().find((m) => m.info.role === 'assistant' && m.parts.some((p) => p.type === 'text'))
  return last?.parts.filter((p) => p.type === 'text').map((p) => String(p.text)).join('\n') ?? ''
}

const canaryName = `.localforge-e2e-canary-${randomBytes(4).toString('hex')}`
const canaryPath = path.join(os.homedir(), canaryName)
let projectId: string | null = null

try {
  await backend.init({ hardware: false })
  const llama = await backend.llamaStatus()
  check('llama-server is up', llama.up, `${llama.modelAlias} vision=${llama.vision} ctx=${llama.nCtx}`)

  // 1. Create a C++ project --------------------------------------------------------------------
  const name = `e2e-cpp-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`
  const created = await backend.createProject({ name, template: 'cpp', description: '' })
  projectId = created.projectId
  check('C++ project created', !!created.sessionId, `${created.projectId}`)
  const pid = created.projectId
  const sh = (s: string, t?: number) => backend.sandboxes.sh(pid, s, t)

  // 2. Hello world with CMake --------------------------------------------------------------------
  const session = await backend.createSession(pid, 'E2E: hello world')
  let since = Date.now()
  let msgs = await ask(pid, session.id, 'create a hello world program with CMake, build it and run it')
  const tools = toolParts(msgs, since)
  check('agent used bash to build/run', tools.some((t) => t.tool === 'bash' && t.state?.status === 'completed'), tools.map((t) => t.tool).join(','))
  // Find ELF executables the agent built (outside .git and vcpkg internals) and run them.
  const bins = (
    await sh(
      `cd /workspace && find . -path ./.git -prune -o -path '*/vcpkg_installed' -prune -o -path '*/CMakeFiles' -prune -o -type f -perm -u+x -print | while read f; do file "$f" | grep -q ELF && echo "$f"; done`,
    )
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  check('a binary exists in /workspace', bins.length > 0, bins.join(' '))
  // A hello-world binary must have been (re)built during this turn, print a hello greeting, and
  // its output must be what the agent reported.
  const answer = lastAnswer(msgs)
  const turnStart = Math.floor(since / 1000) - 2
  let helloBin = ''
  let helloOut = ''
  for (const b of bins) {
    const mtime = Number((await sh(`stat -c %Y ${JSON.stringify(b)}`)).trim())
    const r = await backend.sandboxes.exec(pid, ['bash', '-lc', `timeout 10 ${JSON.stringify(b)}`])
    if (r.code === 0 && /hello/i.test(r.stdout) && mtime >= turnStart) {
      helloBin = b
      helloOut = r.stdout.trim()
      break
    }
  }
  check('a hello-world binary was built during this turn and runs', !!helloBin, `${helloBin} -> ${JSON.stringify(helloOut)}`)
  check('binary prints the expected "Hello, World!" output', /hello,? world!?/i.test(helloOut), JSON.stringify(helloOut))
  check("binary output matches the agent's report", !!helloOut && answer.includes(helloOut.split('\n')[0]), answer.replace(/\s+/g, ' ').slice(0, 200))

  // 3. Screenshot tool returns a real image, and the model can describe it ------------------------
  const mcpScript = `
import json,subprocess,base64,struct
p=subprocess.Popen(["node","/opt/localforge/computer-use-mcp/index.js"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env={"DISPLAY":":1","PATH":"/usr/local/bin:/usr/bin:/bin"})
def rpc(o):
  p.stdin.write(json.dumps(o)+"\\n"); p.stdin.flush()
  if "id" not in o: return None
  while True:
    d=json.loads(p.stdout.readline())
    if d.get("id")==o["id"]: return d
rpc({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}})
rpc({"jsonrpc":"2.0","method":"notifications/initialized"})
r=rpc({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"screenshot","arguments":{}}})
img=[c for c in r["result"]["content"] if c["type"]=="image"][0]
raw=base64.b64decode(img["data"])
w,h=struct.unpack(">II",raw[16:24])
open("/tmp/e2e-shot.png","wb").write(raw)
print(json.dumps({"mime":img["mimeType"],"bytes":len(raw),"png":raw[:8]==b"\\x89PNG\\r\\n\\x1a\\n","w":w,"h":h}))
p.terminate()`
  const shotRun = await backend.sandboxes.exec(pid, ['python3', '-'], { input: mcpScript, timeoutMs: 120_000 })
  if (shotRun.code !== 0) throw new Error(`screenshot MCP call failed: ${shotRun.stderr}`)
  const shotInfo = JSON.parse(shotRun.stdout.trim().split('\n').pop()!)
  check('screenshot tool returns a real PNG image', shotInfo.png && shotInfo.mime === 'image/png' && shotInfo.bytes > 10_000 && shotInfo.w >= 1024, JSON.stringify(shotInfo))
  const png = await backend.sandboxes.exec(pid, ['base64', '-w0', '/tmp/e2e-shot.png'])
  writeFileSync(path.join(outDir, 'screenshot.png'), Buffer.from(png.stdout, 'base64'))

  since = Date.now()
  msgs = await ask(
    pid,
    session.id,
    'Take a screenshot of your desktop with the computer_screenshot tool and describe what you see in 2-3 sentences. List the labels of the desktop icons exactly as written.',
  )
  const shotTool = toolParts(msgs, since).find((t) => String(t.tool).endsWith('screenshot'))
  const attachedImage = (shotTool?.state?.attachments ?? []).some((a: any) => String(a.mime).startsWith('image/'))
  check('agent called the screenshot tool and got an image attachment', !!shotTool && shotTool.state?.status === 'completed' && attachedImage, shotTool?.tool)
  const desc = lastAnswer(msgs)
  const labels = ['Home', 'File System', 'Terminal', 'Chromium', 'Workspace'].filter((l) => desc.toLowerCase().includes(l.toLowerCase()))
  check('model describes the screenshot (names desktop icons)', labels.length >= 3, `${labels.join(', ')} | ${desc.replace(/\s+/g, ' ').slice(0, 300)}`)

  // 4. Web search + web fetch from inside the sandbox ---------------------------------------------
  since = Date.now()
  msgs = await ask(
    pid,
    session.id,
    "Use the websearch tool to search for \"llama.cpp github repository\", then use the webfetch tool to fetch https://example.com . Tell me the first search result's URL and the page title of example.com.",
  )
  const wt = toolParts(msgs, since)
  const ws = wt.find((t) => t.tool === 'websearch')
  const wf = wt.find((t) => t.tool === 'webfetch')
  check('websearch works from the sandbox', ws?.state?.status === 'completed' && String(ws.state.output).length > 100, `${ws?.state?.status} ${String(ws?.state?.output ?? ws?.state?.error ?? '').slice(0, 200)}`)
  check('webfetch works from the sandbox', wf?.state?.status === 'completed' && /Example Domain/i.test(String(wf.state.output)), `${wf?.state?.status} ${String(wf?.state?.output ?? wf?.state?.error ?? '').slice(0, 160)}`)
  const net = (await sh('curl -s -o /dev/null -w "%{http_code}" -m 15 https://example.com')).trim()
  check('sandbox has internet access', net === '200', net)

  // 5. The container cannot see the user's home folder --------------------------------------------
  writeFileSync(canaryPath, `secret-${randomBytes(8).toString('hex')}\n`)
  const home = os.homedir()
  const iso = await sh(
    `echo "whoami=$(whoami) uid=$(id -u)"; echo "home_dirs=$(ls /home | tr '\\n' ' ')"; ` +
      `test -e ${JSON.stringify(home)} && echo HOST_HOME_VISIBLE || echo host_home_absent; ` +
      `find / -xdev -name ${JSON.stringify(canaryName)} 2>/dev/null | head -1 | sed 's/^/CANARY_FOUND /'; ` +
      `find /workspace /tmp /home /root /mnt /media /opt -maxdepth 4 -name ${JSON.stringify(canaryName)} 2>/dev/null | sed 's/^/CANARY_FOUND /'; ` +
      `awk '$5 ~ /^\\/workspace$/ {print "workspace_mount_ok"}' /proc/self/mountinfo; ` +
      `ls /run/podman /var/run/docker.sock /run/user/1000/podman 2>/dev/null | sed 's/^/SOCKET /'; ` +
      `curl -s -m 3 -o /dev/null -w "llama_direct=%{http_code}\\n" http://127.0.0.1:8080/health || true; ` +
      `curl -s -m 5 -o /dev/null -w "proxy=%{http_code}\\n" http://127.0.0.1:${backend.getSettings().proxy.port}/health || true`,
    300_000,
  )
  log(iso.trim().replace(/\n/g, ' | '))
  check('host home folder is not visible in the container', iso.includes('host_home_absent') && !iso.includes('CANARY_FOUND') && /home_dirs=dev\s*$/m.test(iso), iso.split('\n').slice(0, 3).join(' '))
  check('only the project folder is mounted at /workspace', iso.includes('workspace_mount_ok'))
  check('no podman/docker socket inside the sandbox', !iso.includes('SOCKET '))
  check('llama-server is only reachable through the stats proxy', /llama_direct=000/.test(iso) && /proxy=200/.test(iso), (iso.match(/llama_direct=\d+|proxy=\d+/g) ?? []).join(' '))

  // Stats bookkeeping for the session.
  const totals = backend.getTotals(pid, session.id)
  check('stats recorded for the session', totals.session.requests > 0 && totals.session.outputTokens > 0, JSON.stringify(totals.session))
  const ms = backend.getMessageStats(pid, session.id)
  check('assistant messages linked to llama-server requests', Object.keys(ms).length > 0, `${Object.keys(ms).length} linked messages`)
} catch (e) {
  check('no unexpected error', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
} finally {
  rmSync(canaryPath, { force: true })
  if (projectId && !keep) {
    await backend.removeProject(projectId, true).catch(() => {})
    log('removed test project', projectId)
  }
  await backend.shutdown()
  const failed = results.filter((r) => !r.ok)
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ when: new Date().toISOString(), durationS: Math.round((Date.now() - t0) / 1000), results }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (${Math.round((Date.now() - t0) / 1000)}s)`)
  for (const f of failed) console.log('  FAILED:', f.name, f.detail ?? '')
  process.exit(failed.length ? 1 : 0)
}
