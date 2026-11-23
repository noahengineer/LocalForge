import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  BackendEvent,
  ChangesInfo,
  Checkpoint,
  CreateProjectInput,
  FileContent,
  FolderInspection,
  HfModelInfo,
  ImportProjectInput,
  ModelsInfo,
  FileNode,
  ImageBuildState,
  OcMessage,
  OcSession,
  PermissionRequest,
  Project,
  PromptInput,
  QuestionRequest,
  SandboxStatus,
  TemplateInfo,
} from '../../shared/api'
import type { DeepPartial, Settings } from '../../shared/settings'
import type { HardwareSample, LlamaServerStatus, LlmRequestStats, MessageStats, TotalsStats } from '../../shared/stats'
import { changes, checkpointSubject, commitCheckpoint, headCommit, listCheckpoints, resetTo, shq } from './checkpoints'
import { listDir, readProjectFile } from './files'
import { HardwareMonitor } from './hardware'
import { ImageManager } from './image'
import { controlUnit, getLlamaStatus, unitLogs } from './llama'
import { applyReasoningEffort, applyServerOptions, lookupHfModel, modelsInfo, switchModel } from './models'
import { OpenCodeConnection, type OcEvent } from './opencode'
import { buildOpenCodeConfig, modelKeyOf, PROVIDER_ID } from './opencodeConfig'
import { dataDir, expandHome, sandboxDir } from './paths'
import { Podman } from './podman'
import { CreateTracker, ensureNewFolder, folderNameOf, gitInit, hostGitIdentity, IMPORT_STEPS, makeProject, newProjectId, ProjectStore, validateProjectName } from './projects'
import { inspectFolder } from './importer'
import { SandboxManager } from './sandbox'
import { SettingsStore } from './settingsStore'
import { StatsProxy } from './stats/proxy'
import { StatsStore, type OcTokens } from './statsStore'
import { agentsMd, getTemplate, importedAgentsMd, loadTemplates, scaffold, templateVars } from './templates'

/** Events that are pure noise for the UI and are not forwarded. */
const DROP_EVENTS = new Set(['server.heartbeat', 'plugin.added', 'catalog.updated', 'reference.updated', 'integration.updated', 'models-dev.refreshed', 'lsp.updated'])

interface PendingLink {
  sessionId: string
  messageId: string
  tokens: OcTokens | null
  completedAt: number | null
}

export interface BackendOptions {
  settingsFile?: string
  dataDir?: string
}

export class Backend extends EventEmitter<{ event: [BackendEvent] }> {
  readonly settings: SettingsStore
  readonly podman: Podman
  readonly images: ImageManager
  readonly sandboxes: SandboxManager
  readonly proxy: StatsProxy
  readonly hardware: HardwareMonitor
  readonly stats: StatsStore
  readonly projects: ProjectStore
  private conns = new Map<string, OpenCodeConnection>()
  private connecting = new Map<string, Promise<OpenCodeConnection>>()
  private ptys = new Map<string, { projectId: string; send: (s: string) => void; close: () => void }>()
  private pendingLinks = new Map<string, PendingLink[]>()
  private timers: NodeJS.Timeout[] = []
  private llama: LlamaServerStatus | null = null
  private readonly dataRoot: string
  private modelId: string | null = null

  constructor(opts: BackendOptions = {}) {
    super()
    this.dataRoot = opts.dataDir ?? dataDir()
    this.settings = new SettingsStore(opts.settingsFile)
    this.podman = new Podman(() => ({ root: expandHome(this.settings.get().sandbox.podmanRoot) }))
    this.images = new ImageManager(this.podman, sandboxDir)
    this.sandboxes = new SandboxManager(this.podman, () => this.settings.get())
    const s = this.settings.get()
    this.proxy = new StatsProxy({
      port: s.proxy.port,
      upstream: s.llama.baseUrl,
      injectStatsFields: s.proxy.injectStats,
      rewriteBody: (b) => applyReasoningEffort(b, this.settings.get().llama.reasoningEffort, this.llama?.reasoningLevels ?? null),
    })
    this.hardware = new HardwareMonitor(() => this.liveTps())
    this.stats = new StatsStore(path.join(this.dataRoot, 'stats'))
    this.projects = new ProjectStore(path.join(this.dataRoot, 'projects.json'))
    try {
      this.modelId = (JSON.parse(readFileSync(path.join(this.dataRoot, 'state.json'), 'utf8')) as { modelId?: string }).modelId ?? null
    } catch {
      this.modelId = null
    }

    this.images.on('progress', (state) => this.send({ type: 'image-build', state }))
    this.sandboxes.on('status', (status) => this.send({ type: 'sandbox-status', status }))
    this.hardware.on('sample', (sample) => this.send({ type: 'hardware', sample }))
    this.proxy.on('start', (st) => this.send({ type: 'llm-start', stats: st }))
    this.proxy.on('update', (st) => this.send({ type: 'llm-update', stats: st }))
    this.proxy.on('end', (st) => this.onRequestEnd(st))
    this.settings.on('changed', (cur, prev) => void this.onSettingsChanged(cur, prev))
  }

  private send(ev: BackendEvent): void {
    this.emit('event', ev)
  }

  private toast(level: 'info' | 'error' | 'success', message: string): void {
    this.send({ type: 'toast', level, message })
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle

  async init(opts: { hardware?: boolean; polling?: boolean } = {}): Promise<void> {
    mkdirSync(this.dataRoot, { recursive: true })
    try {
      await this.proxy.start()
    } catch (e) {
      this.toast('error', `Stats proxy could not listen on 127.0.0.1:${this.settings.get().proxy.port}: ${(e as Error).message}`)
    }
    if (opts.hardware !== false) this.hardware.start()
    if (opts.polling !== false) {
      const pollLlama = async () => {
        const st = await getLlamaStatus(this.settings.get().llama.baseUrl, this.settings.get().llama.systemdUnit)
        this.llama = st
        this.send({ type: 'llama-status', status: st })
      }
      void pollLlama()
      this.timers.push(setInterval(() => void pollLlama(), 2000))
      this.timers.push(setInterval(() => void this.sandboxes.pollStats([...this.conns.keys()]).catch(() => {}), 3000))
    }
    void this.images.check().catch(() => {})
    for (const p of this.projects.list()) void this.sandboxes.refresh(p.id).catch(() => {})
  }

  async shutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.hardware.stop()
    for (const p of this.ptys.values()) p.close()
    this.ptys.clear()
    for (const c of this.conns.values()) c.stop()
    const ids = [...this.conns.keys()]
    this.conns.clear()
    if (this.settings.get().sandbox.stopOnQuit) {
      await Promise.all(ids.map((id) => this.sandboxes.stop(id).catch(() => {})))
    }
    await this.proxy.stop()
  }

  private async onSettingsChanged(cur: Settings, prev: Settings): Promise<void> {
    this.send({ type: 'settings', settings: cur })
    if (cur.llama.baseUrl !== prev.llama.baseUrl) this.proxy.setUpstream(cur.llama.baseUrl)
    if (cur.proxy.port !== prev.proxy.port) {
      await this.proxy.stop()
      // Re-create the proxy listener on the new port.
      this.proxy.setPort(cur.proxy.port)
      await this.proxy.start().catch((e) => this.toast('error', `Stats proxy: ${(e as Error).message}`))
      this.toast('info', 'Proxy port changed: use "Reset sandbox" on existing projects so they use the new port.')
    }
    const cfgChanged =
      cur.agent.requireApproval !== prev.agent.requireApproval ||
      cur.sandbox.computerUseCoords !== prev.sandbox.computerUseCoords ||
      cur.llama.contextLimit !== prev.llama.contextLimit ||
      cur.llama.outputLimit !== prev.llama.outputLimit ||
      cur.llama.modelName !== prev.llama.modelName
    if (cfgChanged) {
      for (const id of this.conns.keys()) {
        const p = this.projects.find(id)
        if (p) await this.sandboxes.writeOpenCodeConfig(id, await this.openCodeConfigFor(p)).catch(() => {})
      }
    }
    if (cur.sandbox.cpus !== prev.sandbox.cpus || cur.sandbox.memoryGb !== prev.sandbox.memoryGb) {
      for (const p of this.projects.list()) {
        if (!(await this.podman.containerExists(`localforge-${p.id}`))) continue
        await this.podman
          .run(['update', '--cpus', String(cur.sandbox.cpus), '--memory', `${cur.sandbox.memoryGb}g`, '--memory-swap', `${cur.sandbox.memoryGb}g`, `localforge-${p.id}`])
          .catch(() => {})
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Model / OpenCode config

  private liveTps(): number {
    let tps = 0
    for (const r of this.proxy.active.values()) {
      if ((r.phase === 'thinking' || r.phase === 'writing' || r.phase === 'tool') && r.predictedPerSecond) tps += r.predictedPerSecond
    }
    return Math.round(tps * 100) / 100
  }

  async resolveModelId(): Promise<string> {
    try {
      const r = await fetch(`${this.settings.get().llama.baseUrl.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(3000) })
      const j = (await r.json()) as { data?: Array<{ id: string }> }
      const id = j.data?.[0]?.id
      if (id) {
        if (id !== this.modelId) {
          this.modelId = id
          mkdirSync(this.dataRoot, { recursive: true })
          writeFileSync(path.join(this.dataRoot, 'state.json'), JSON.stringify({ modelId: id }))
        }
        return id
      }
    } catch {
      /* llama-server down: fall back to the last known model */
    }
    return this.modelId ?? 'local-model'
  }

  async openCodeConfigFor(_p: Project): Promise<string> {
    const s = this.settings.get()
    const modelId = await this.resolveModelId()
    const cfg = buildOpenCodeConfig({
      projectId: _p.id,
      proxyPort: s.proxy.port,
      modelId,
      modelName: s.llama.modelName || prettyModelName(modelId),
      contextLimit: s.llama.contextLimit,
      outputLimit: s.llama.outputLimit,
      vision: this.llama ? this.llama.vision || !this.llama.up : true,
      requireApproval: s.agent.requireApproval,
      computerUseCoords: s.sandbox.computerUseCoords,
    })
    return JSON.stringify(cfg, null, 2) + '\n'
  }

  async modelRef(): Promise<{ providerID: string; modelID: string }> {
    return { providerID: PROVIDER_ID, modelID: modelKeyOf(await this.resolveModelId()) }
  }

  // ---------------------------------------------------------------------------------------------
  // Sandboxes & OpenCode connections

  /** Ensure the project's sandbox runs and an OpenCode connection is live. */
  connect(projectId: string): Promise<OpenCodeConnection> {
    const existing = this.conns.get(projectId)
    if (existing) return Promise.resolve(existing)
    const inflight = this.connecting.get(projectId)
    if (inflight) return inflight
    const p = (async () => {
      const project = this.projects.get(projectId)
      const image = await this.images.ensure()
      const created = !(await this.podman.containerExists(`localforge-${projectId}`))
      const rt = await this.sandboxes.ensureRunning(project, image, await this.openCodeConfigFor(project))
      const conn = new OpenCodeConnection(`http://127.0.0.1:${rt.opencodePort}`, rt.password)
      try {
        await conn.waitHealthy(120_000)
      } catch (e) {
        const log = await this.sandboxes.exec(projectId, ['tail', '-n', '15', '/tmp/localforge/logs/opencode.log']).catch(() => null)
        const msg = `${(e as Error).message}${log?.stdout ? `\nOpenCode log:\n${log.stdout}` : ''}`
        this.sandboxes.setStatus(projectId, { state: 'error', error: msg })
        throw new Error(msg)
      }
      if (created) await this.afterContainerCreated(projectId).catch((e) => this.toast('error', `Sandbox setup: ${(e as Error).message}`))
      if (project.rulesInSandbox) await this.writeSandboxRules(project).catch((e) => this.toast('error', `Sandbox rules: ${(e as Error).message}`))
      conn.on('event', (ev) => this.onOcEvent(projectId, ev))
      conn.on('connection', (c) => this.send({ type: 'oc-connection', projectId, connected: c }))
      conn.startEvents()
      this.conns.set(projectId, conn)
      this.sandboxes.setStatus(projectId, { opencodeReady: true, error: null })
      return conn
    })().finally(() => this.connecting.delete(projectId))
    this.connecting.set(projectId, p)
    return p
  }

  /** One-time setup for a freshly created container (also after "Reset sandbox"). */
  private async afterContainerCreated(projectId: string): Promise<void> {
    // Git identity for commits made in the sandbox (checkpoints, and the agent's own commits in
    // repositories that have no identity configured): the host user's.
    const id = await hostGitIdentity()
    await this.sandboxes.sh(projectId, `git config --global user.name ${shq(id.name)} && git config --global user.email ${shq(id.email)}`, 30_000)
    // graphify's OpenCode skill lives in the container's home, so (re)install it.
    await this.sandboxes.sh(projectId, 'graphify install --platform opencode >/dev/null', 120_000)
  }

  /**
   * Imported projects that have their own AGENTS.md/CLAUDE.md keep it untouched; LocalForge's rules
   * go into the sandbox's global ~/.config/opencode/AGENTS.md, which OpenCode loads in addition.
   */
  private async writeSandboxRules(project: Project): Promise<void> {
    const own = (['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'] as const).find((f) => existsSync(path.join(project.path, f))) ?? null
    const md = importedAgentsMd({
      name: project.name,
      description: project.description,
      stack: project.stack ?? { kinds: [], commands: {}, notes: [] },
      ownInstructionsFile: own,
      graph: existsSync(path.join(project.path, 'graphify-out')),
      checkpoints: project.checkpoints !== false,
    })
    await this.sandboxes.writeFile(project.id, '/home/dev/.config/opencode/AGENTS.md', md)
  }

  private disconnect(projectId: string): void {
    const c = this.conns.get(projectId)
    if (c) c.stop()
    this.conns.delete(projectId)
    for (const [id, pty] of this.ptys) {
      if (pty.projectId === projectId) {
        pty.close()
        this.ptys.delete(id)
      }
    }
  }

  async startSandbox(projectId: string): Promise<SandboxStatus> {
    await this.connect(projectId)
    return this.sandboxes.status(projectId)
  }

  async stopSandbox(projectId: string): Promise<void> {
    this.disconnect(projectId)
    await this.sandboxes.stop(projectId)
  }

  /** Rebuild the container from the current image, keeping project files and sessions. */
  async resetSandbox(projectId: string): Promise<SandboxStatus> {
    this.disconnect(projectId)
    await this.sandboxes.remove(projectId, false)
    await this.connect(projectId)
    return this.sandboxes.status(projectId)
  }

  async sandboxStatus(projectId: string): Promise<SandboxStatus> {
    const st = await this.sandboxes.refresh(projectId)
    return { ...st, opencodeReady: this.conns.has(projectId) }
  }

  private conn(projectId: string): Promise<OpenCodeConnection> {
    return this.connect(projectId)
  }

  // ---------------------------------------------------------------------------------------------
  // OpenCode events -> UI, stats linking, checkpoints

  private onOcEvent(projectId: string, ev: OcEvent): void {
    if (DROP_EVENTS.has(ev.type) || ev.type.startsWith('session.next.')) return
    this.send({ type: 'oc', projectId, event: ev })
    const p = ev.properties ?? {}
    if (ev.type === 'message.updated' && p.info?.role === 'assistant' && p.info?.time?.completed) {
      this.tryLink(projectId, {
        sessionId: p.info.sessionID,
        messageId: p.info.id,
        tokens: p.info.tokens ?? null,
        completedAt: p.info.time.completed,
      })
    } else if (ev.type === 'session.idle' && p.sessionID) {
      void this.onSessionIdle(projectId, p.sessionID)
    }
  }

  private tryLink(projectId: string, pl: PendingLink): void {
    const req = this.stats.linkMessage(projectId, pl.sessionId, pl.messageId, pl.tokens, pl.completedAt)
    if (req) {
      this.emitMessageStats(projectId, pl.sessionId, pl.messageId)
      return
    }
    const list = this.pendingLinks.get(projectId) ?? []
    if (!list.some((x) => x.messageId === pl.messageId)) list.push(pl)
    this.pendingLinks.set(projectId, list.slice(-50))
  }

  private emitMessageStats(projectId: string, sessionId: string, messageId: string): void {
    const all = this.stats.sessionMessageStats(projectId, sessionId)
    const m = all[messageId]
    if (m) this.send({ type: 'message-stats', projectId, sessionId, messageId, stats: m.stats, requests: m.requests })
    const t = this.stats.totals(projectId, sessionId)
    this.send({ type: 'totals', projectId, sessionId, session: t.session, project: t.project })
  }

  private onRequestEnd(st: LlmRequestStats): void {
    this.stats.add(st)
    this.send({ type: 'llm-end', stats: st })
    if (!st.projectId) return
    const pending = this.pendingLinks.get(st.projectId)
    if (pending?.length) {
      const still: PendingLink[] = []
      for (const pl of pending) {
        if (this.stats.linkMessage(st.projectId, pl.sessionId, pl.messageId, pl.tokens, pl.completedAt)) this.emitMessageStats(st.projectId, pl.sessionId, pl.messageId)
        else still.push(pl)
      }
      this.pendingLinks.set(st.projectId, still)
    }
    if (st.sessionId) {
      const t = this.stats.totals(st.projectId, st.sessionId)
      this.send({ type: 'totals', projectId: st.projectId, sessionId: st.sessionId, session: t.session, project: t.project })
    }
  }

  private async onSessionIdle(projectId: string, sessionId: string): Promise<void> {
    if (!this.settings.get().agent.autoCheckpoint) return
    if (this.projects.find(projectId)?.checkpoints === false) return
    try {
      const conn = await this.conn(projectId)
      // Subagent sessions go idle in the middle of their parent's turn: only checkpoint top-level turns.
      const session = await conn.getSession(sessionId).catch(() => null)
      if (session?.parentID) return
      const msgs = await conn.messages(sessionId)
      const lastUser = [...msgs].reverse().find((m) => m.info.role === 'user')
      if (!lastUser) return
      const text = lastUser.parts.filter((x) => x.type === 'text' && !x.synthetic).map((x) => String(x.text ?? '')).join(' ')
      const cp = await commitCheckpoint((s, t) => this.sandboxes.sh(projectId, s, t), {
        subject: checkpointSubject(text),
        sessionId,
        messageId: lastUser.info.id,
      })
      if (cp) this.send({ type: 'checkpoint', projectId, checkpoint: cp })
    } catch (e) {
      this.toast('error', `Checkpoint failed: ${(e as Error).message}`)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Projects

  listTemplates(): TemplateInfo[] {
    return loadTemplates().map(({ id, name, description, commands }) => ({ id, name, description, commands }))
  }

  listProjects(): Project[] {
    return this.projects.list()
  }

  /** One-click project creation. Progress is streamed as 'create-progress' events. */
  async createProject(input: CreateProjectInput): Promise<{ projectId: string; sessionId: string | null }> {
    const err = validateProjectName(input.name)
    if (err) throw new Error(err)
    const tracker = new CreateTracker(input.name.trim(), (progress) => this.send({ type: 'create-progress', progress }))
    const s = this.settings.get()
    const root = expandHome(s.projects.root)
    const template = getTemplate(input.template)
    const vars = templateVars(input.name.trim(), input.description)
    let projectId: string | null = null
    try {
      const dir = await tracker.step('folder', async () => {
        mkdirSync(root, { recursive: true })
        return ensureNewFolder(root, folderNameOf(input.name))
      })
      await tracker.step('scaffold', async () => {
        scaffold(input.template, dir, vars)
      })
      await tracker.step('agents', async () => {
        writeFileSync(path.join(dir, 'AGENTS.md'), agentsMd(template, vars))
      })
      await tracker.step('git', async () => {
        await gitInit(dir)
      })
      const id = newProjectId(input.name)
      projectId = id
      const project = makeProject({ id, name: input.name, dir, template: input.template, description: input.description })
      this.projects.add(project)
      this.send({ type: 'projects', projects: this.projects.list() })
      tracker.progress.projectId = id

      await tracker.step('image', () => this.images.ensure())
      const conn = await tracker.step('container', async () => {
        // connect() creates + starts the container, writes the OpenCode config and waits for it.
        return this.connect(id)
      })
      await tracker.step('opencode', async () => {
        await conn.waitHealthy(60_000)
        const mcp = await conn.client.mcp.status({ directory: '/workspace' }).catch(() => null)
        const st = (mcp?.data ?? {}) as Record<string, { status?: string }>
        const bad = Object.entries(st).filter(([, v]) => v?.status && v.status !== 'connected')
        if (bad.length) tracker.set('opencode', 'running', `MCP: ${bad.map(([k, v]) => `${k}=${v.status}`).join(', ')}`)
      })
      if (template.commands.setup) {
        await tracker.step('deps', () => this.sandboxes.sh(id, template.commands.setup!, 20 * 60_000), template.commands.setup)
      } else {
        tracker.set('deps', 'skipped', 'Nothing to install')
      }
      await tracker.step('graphify', () => this.sandboxes.sh(id, 'graphify install --platform opencode >/dev/null && graphify update . 2>&1 | tail -n 3', 10 * 60_000))
      await tracker.step('commit', async () => {
        await this.sandboxes.sh(
          id,
          `git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null commit -q --no-verify -m ${JSON.stringify(`Initial commit (LocalForge ${template.name} template)`)}`,
        )
        this.projects.update(id, { baseCommit: await headCommit((sc, t) => this.sandboxes.sh(id, sc, t)) })
      })
      const sessionId = await tracker.step('session', async () => {
        const desc = input.description.trim()
        const session = await conn.createSession(desc ? shortTitle(desc) : `${input.name.trim()}`)
        this.projects.update(id, { lastSessionId: session.id })
        if (desc) {
          await conn.promptAsync({
            sessionID: session.id,
            agent: 'plan',
            model: await this.modelRef(),
            parts: [{ type: 'text', text: desc }],
          })
        }
        return session.id
      })
      tracker.finish({ projectId: id, sessionId })
      this.send({ type: 'projects', projects: this.projects.list() })
      return { projectId: id, sessionId }
    } catch (e) {
      tracker.finish({ error: e instanceof Error ? e.message : String(e), projectId })
      throw e
    }
  }

  /** Read-only look at a folder before importing it. */
  inspectFolder(p: string): FolderInspection {
    return inspectFolder(p, this.projects.list())
  }

  /** Overridden by the Electron main process (native dialog). */
  async pickFolder(): Promise<string | null> {
    return null
  }

  /**
   * Open an existing folder as a project, in place: the folder is mounted at /workspace, nothing is
   * moved or copied. Git checkpoints are optional; when on, a non-git folder gets `git init`, and
   * uncommitted work is committed as a snapshot so "Undo" can always get back to the imported state.
   */
  async importProject(input: ImportProjectInput): Promise<{ projectId: string; sessionId: string | null }> {
    const name = input.name.trim()
    const err = validateProjectName(name)
    if (err) throw new Error(err)
    const tracker = new CreateTracker(name, (progress) => this.send({ type: 'create-progress', progress }), IMPORT_STEPS)
    let projectId: string | null = null
    try {
      const insp = await tracker.step('inspect', async () => {
        const r = this.inspectFolder(input.path)
        if (!r.ok) throw new Error(r.error ?? 'This folder cannot be imported.')
        return r
      })
      tracker.set('inspect', 'done', [insp.path, insp.stack.kinds.join(', ') || 'stack not detected', ...insp.warnings].join('\n'))
      const checkpoints = input.checkpoints && insp.git.kind !== 'linked'
      const id = newProjectId(name)
      projectId = id
      tracker.progress.projectId = id
      const project: Project = {
        id,
        name,
        path: insp.path,
        template: 'imported',
        description: input.description.trim(),
        createdAt: Date.now(),
        lastSessionId: null,
        baseCommit: null,
        checkpoints,
        rulesInSandbox: insp.instructionsFile !== null,
        stack: insp.stack,
      }
      this.projects.add(project)
      this.send({ type: 'projects', projects: this.projects.list() })

      await tracker.step('image', () => this.images.ensure())
      const conn = await tracker.step('container', () => this.connect(id))
      await tracker.step('opencode', () => conn.waitHealthy(60_000))
      const sh = (sc: string, t?: number) => this.sandboxes.sh(id, sc, t)
      const G = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false'

      if (checkpoints) {
        await tracker.step('git', async () => {
          const fresh = insp.git.kind !== 'repo'
          // Local-only ignores (.git/info/exclude): the user's .gitignore is never modified. A brand
          // new repository also ignores common dependency/build folders so the first commit stays small.
          // Dependency folders are always excluded (only affects *untracked* files, so nothing the
          // repository already tracks changes); build-output names only for brand-new repositories.
          const excludes = [
            'graphify-out/',
            '.playwright-mcp/',
            'node_modules/',
            '.venv/',
            '__pycache__/',
            '*.pyc',
            ...(fresh ? ['venv/', 'target/', 'build/', 'dist/', '.DS_Store'] : []),
          ]
          const out = await sh(
            `cd /workspace && ${fresh ? `${G} init -q -b main && ` : ''}mkdir -p .git/info && touch .git/info/exclude && ` +
              excludes.map((e) => `(grep -qxF ${shq(e)} .git/info/exclude || echo ${shq(e)} >> .git/info/exclude)`).join(' && ') +
              ` && ${G} add -A && if ! ${G} rev-parse -q --verify HEAD >/dev/null; then ${G} commit -q --no-verify --allow-empty -m "Initial commit (imported into LocalForge)" && echo INIT; ` +
              `elif ! ${G} diff --cached --quiet; then N=$(${G} diff --cached --name-only | wc -l); ${G} commit -q --no-verify -m "LocalForge: snapshot of uncommitted changes at import" && echo "SNAPSHOT $N"; else echo CLEAN; fi`,
            10 * 60_000,
          )
          const last = out.trim().split('\n').pop() ?? ''
          tracker.set(
            'git',
            'running',
            last === 'INIT'
              ? 'Initialized a git repository and committed the current files'
              : last.startsWith('SNAPSHOT')
                ? `Committed ${last.split(' ')[1]} uncommitted file(s) as a snapshot, so Undo can return to this exact state`
                : `Using the existing repository${insp.git.branch ? ` (branch ${insp.git.branch})` : ''}`,
          )
        })
      } else {
        tracker.set('git', 'skipped', insp.git.kind === 'linked' ? 'Git worktree/submodule: checkpoints unavailable' : 'Checkpoints off: git is not touched')
      }

      await tracker.step('agents', async () => {
        const md = importedAgentsMd({
          name,
          description: project.description,
          stack: insp.stack,
          ownInstructionsFile: insp.instructionsFile,
          graph: input.graph,
          checkpoints,
        })
        if (insp.instructionsFile) {
          await this.writeSandboxRules(this.projects.get(id))
          tracker.set('agents', 'running', `Kept your ${insp.instructionsFile}; LocalForge's rules were added inside the sandbox only`)
        } else {
          writeFileSync(path.join(insp.path, 'AGENTS.md'), md)
          if (checkpoints) await sh(`cd /workspace && ${G} add AGENTS.md && ${G} commit -q --no-verify -m "Add AGENTS.md (LocalForge)"`)
          tracker.set('agents', 'running', 'Wrote AGENTS.md (rules, detected commands, sandbox environment)')
        }
        if (checkpoints) this.projects.update(id, { baseCommit: await headCommit(sh) })
      })

      if (input.graph) await tracker.softStep('graphify', () => sh('graphify update . 2>&1 | tail -n 2', 20 * 60_000))
      else tracker.set('graphify', 'skipped', 'Not requested')

      const sessionId = await tracker.step('session', async () => {
        const desc = project.description
        const session = await conn.createSession(desc ? shortTitle(desc) : name)
        this.projects.update(id, { lastSessionId: session.id })
        if (desc) await conn.promptAsync({ sessionID: session.id, agent: 'plan', model: await this.modelRef(), parts: [{ type: 'text', text: desc }] })
        return session.id
      })
      tracker.finish({ projectId: id, sessionId })
      this.send({ type: 'projects', projects: this.projects.list() })
      return { projectId: id, sessionId }
    } catch (e) {
      tracker.finish({ error: e instanceof Error ? e.message : String(e), projectId })
      throw e
    }
  }

  async removeProject(projectId: string, deleteFiles: boolean): Promise<void> {
    const p = this.projects.get(projectId)
    this.disconnect(projectId)
    await this.sandboxes.remove(projectId, true).catch(() => {})
    this.projects.remove(projectId)
    rmSync(path.join(this.dataRoot, 'stats', `${projectId}.jsonl`), { force: true })
    // An imported folder belongs to the user: removing the project never deletes it.
    if (deleteFiles && p.template !== 'imported' && existsSync(p.path)) {
      const trashed = await new Promise<boolean>((resolve) => {
        const c = spawn('gio', ['trash', p.path], { stdio: 'ignore' })
        c.on('error', () => resolve(false))
        c.on('close', (code) => resolve(code === 0))
      })
      if (!trashed) rmSync(p.path, { recursive: true, force: true })
    }
    this.send({ type: 'projects', projects: this.projects.list() })
  }

  openProjectFolder(projectId: string): void {
    const p = this.projects.get(projectId)
    spawn('xdg-open', [p.path], { detached: true, stdio: 'ignore' }).unref()
  }

  // ---------------------------------------------------------------------------------------------
  // Sessions & chat

  async listSessions(projectId: string): Promise<OcSession[]> {
    const conn = await this.conn(projectId)
    const list = await conn.listSessions()
    return list.sort((a, b) => b.time.updated - a.time.updated)
  }

  async createSession(projectId: string, title?: string): Promise<OcSession> {
    const conn = await this.conn(projectId)
    const s = await conn.createSession(title)
    this.projects.update(projectId, { lastSessionId: s.id })
    return s
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    await (await this.conn(projectId)).deleteSession(sessionId)
  }

  async renameSession(projectId: string, sessionId: string, title: string): Promise<void> {
    await (await this.conn(projectId)).renameSession(sessionId, title)
  }

  async getMessages(projectId: string, sessionId: string): Promise<OcMessage[]> {
    this.projects.update(projectId, { lastSessionId: sessionId })
    return (await this.conn(projectId)).messages(sessionId)
  }

  async getSessionStatus(projectId: string): Promise<Record<string, { type: string }>> {
    return (await this.conn(projectId)).status()
  }

  async prompt(input: PromptInput): Promise<void> {
    const conn = await this.conn(input.projectId)
    const parts: Array<Record<string, unknown>> = []
    if (input.text.trim()) parts.push({ type: 'text', text: input.text })
    for (const f of input.files ?? []) {
      const rel = f.path.replace(/^\/+/, '').replace(/^workspace\//, '')
      parts.push({ type: 'file', mime: 'text/plain', filename: rel, url: `file:///workspace/${rel}` })
    }
    for (const img of input.images ?? []) {
      parts.push({ type: 'file', mime: img.mime, filename: img.filename ?? 'pasted-image.png', url: img.dataUrl })
    }
    if (parts.length === 0) throw new Error('empty prompt')
    // Name new sessions after their first message (no extra LLM call for titles).
    try {
      const session = await conn.getSession(input.sessionId)
      if (!session.title || /^New session/i.test(session.title)) {
        const msgs = await conn.messages(input.sessionId)
        if (msgs.length === 0 && input.text.trim()) await conn.renameSession(input.sessionId, shortTitle(input.text))
      }
    } catch {
      /* cosmetic */
    }
    await conn.promptAsync({ sessionID: input.sessionId, agent: input.agent, model: await this.modelRef(), parts })
  }

  async abort(projectId: string, sessionId: string): Promise<void> {
    await (await this.conn(projectId)).abortSession(sessionId)
  }

  async replyPermission(projectId: string, requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await (await this.conn(projectId)).replyPermission(requestId, reply, message)
  }

  async replyQuestion(projectId: string, requestId: string, answers: string[][]): Promise<void> {
    await (await this.conn(projectId)).replyQuestion(requestId, answers)
  }

  async rejectQuestion(projectId: string, requestId: string): Promise<void> {
    await (await this.conn(projectId)).rejectQuestion(requestId)
  }

  async pendingRequests(projectId: string): Promise<{ permissions: PermissionRequest[]; questions: QuestionRequest[] }> {
    const conn = await this.conn(projectId)
    const [permissions, questions] = await Promise.all([conn.listPermissions().catch(() => []), conn.listQuestions().catch(() => [])])
    return { permissions, questions }
  }

  async findFiles(projectId: string, query: string): Promise<string[]> {
    return (await this.conn(projectId)).findFiles(query, 30)
  }

  // ---------------------------------------------------------------------------------------------
  // Stats

  getMessageStats(projectId: string, sessionId: string): Record<string, { stats: MessageStats; requests: LlmRequestStats[] }> {
    return this.stats.sessionMessageStats(projectId, sessionId)
  }

  getTotals(projectId: string, sessionId: string | null): { session: TotalsStats; project: TotalsStats } {
    return this.stats.totals(projectId, sessionId)
  }

  activeRequests(): LlmRequestStats[] {
    return [...this.proxy.active.values()].map((r) => ({ ...r }))
  }

  hardwareHistory(): HardwareSample[] {
    return [...this.hardware.history]
  }

  // ---------------------------------------------------------------------------------------------
  // Checkpoints & changes

  async listCheckpoints(projectId: string): Promise<Checkpoint[]> {
    await this.conn(projectId)
    const base = this.projects.get(projectId).baseCommit
    return listCheckpoints((s, t) => this.sandboxes.sh(projectId, s, t), { base })
  }

  /**
   * Undo to a checkpoint: hide the conversation after that checkpoint's turn (OpenCode revert,
   * which also restores files from its snapshots) and reset the files to the checkpoint commit.
   */
  async undoToCheckpoint(projectId: string, sessionId: string | null, commit: string): Promise<void> {
    const conn = await this.conn(projectId)
    const cps = await this.listCheckpoints(projectId)
    const cp = cps.find((c) => c.commit === commit || c.shortCommit === commit)
    if (!cp) throw new Error('checkpoint not found')
    const sid = sessionId ?? cp.sessionId
    if (sid) {
      const msgs = await conn.messages(sid)
      const users = msgs.filter((m) => m.info.role === 'user')
      let revertTo: string | null = null
      if (cp.messageId && cp.sessionId === sid) {
        const idx = users.findIndex((u) => u.info.id === cp.messageId)
        if (idx >= 0 && idx + 1 < users.length) revertTo = users[idx + 1].info.id
      } else if (!cp.sessionId) {
        // The initial commit: undo the whole conversation of this session.
        revertTo = users[0]?.info.id ?? null
      }
      if (revertTo) {
        const status = await conn.status().catch(() => ({}) as Record<string, { type: string }>)
        if (status[sid]?.type === 'busy') await conn.abortSession(sid).catch(() => {})
        await conn.revert(sid, revertTo)
      }
    }
    await resetTo((s, t) => this.sandboxes.sh(projectId, s, t), cp.commit)
  }

  async rerunMessage(projectId: string, sessionId: string, messageId: string, newText: string | null): Promise<void> {
    const conn = await this.conn(projectId)
    const msgs = await conn.messages(sessionId)
    const msg = msgs.find((m) => m.info.id === messageId && m.info.role === 'user')
    if (!msg) throw new Error('message not found')
    const originalText = msg.parts
      .filter((p) => p.type === 'text' && !p.synthetic && !p.ignored)
      .map((p) => String(p.text ?? ''))
      .join('\n')
    const text = newText ?? originalText
    const parts: Array<Record<string, unknown>> = []
    if (text.trim()) parts.push({ type: 'text', text })
    for (const f of msg.parts.filter((p) => p.type === 'file')) parts.push({ type: 'file', mime: f.mime, filename: f.filename, url: f.url })
    if (parts.length === 0) throw new Error('empty message')
    const agent = msg.info.agent === 'plan' ? 'plan' : 'build'

    const status = await conn.status().catch(() => ({}) as Record<string, { type: string }>)
    if (status[sessionId]?.type === 'busy') {
      await conn.abortSession(sessionId).catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
    }
    // Files: back to the state before this message. With git checkpoints, that is the parent of
    // the first checkpoint made by this message or any later one in this session (or the last
    // checkpoint, dropping uncommitted changes from an interrupted turn). OpenCode's revert below
    // also restores its own file snapshots.
    if (this.projects.find(projectId)?.checkpoints !== false) {
      const sh = (sc: string, t?: number) => this.sandboxes.sh(projectId, sc, t)
      const users = msgs.filter((m) => m.info.role === 'user')
      const later = new Set(users.slice(users.findIndex((u) => u.info.id === messageId)).map((u) => u.info.id))
      const cps = await this.listCheckpoints(projectId).catch(() => [])
      const mine = cps.filter((c) => c.sessionId === sessionId && c.messageId && later.has(c.messageId))
      const oldest = mine[mine.length - 1] // list is newest first
      const target = oldest ? (await sh(`cd /workspace && git rev-parse ${shq(oldest.commit + '^')}`).catch(() => '')).trim() : (await sh('cd /workspace && git rev-parse HEAD').catch(() => '')).trim()
      if (/^[0-9a-f]{40}$/.test(target)) await resetTo(sh, target)
    }
    await conn.revert(sessionId, messageId)
    await conn.promptAsync({ sessionID: sessionId, agent, model: await this.modelRef(), parts })
  }

  async getChanges(projectId: string): Promise<ChangesInfo> {
    await this.conn(projectId)
    return changes((s, t) => this.sandboxes.sh(projectId, s, t))
  }

  // ---------------------------------------------------------------------------------------------
  // Files (read on the host, confined to the project folder)

  listDir(projectId: string, rel: string): Promise<FileNode[]> {
    return listDir(this.projects.get(projectId).path, rel)
  }

  readFile(projectId: string, rel: string): Promise<FileContent> {
    return readProjectFile(this.projects.get(projectId).path, rel)
  }

  // ---------------------------------------------------------------------------------------------
  // llama-server

  async llamaStatus(): Promise<LlamaServerStatus> {
    const st = await getLlamaStatus(this.settings.get().llama.baseUrl, this.settings.get().llama.systemdUnit)
    this.llama = st
    return st
  }

  llamaControl(action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; message: string }> {
    return controlUnit(this.settings.get().llama.systemdUnit, action)
  }

  llamaLogs(): Promise<string> {
    return unitLogs(this.settings.get().llama.systemdUnit, 120)
  }

  modelsInfo(): Promise<ModelsInfo> {
    return modelsInfo(this.settings.get().llama.systemdUnit)
  }

  lookupHfModel(repo: string): Promise<HfModelInfo> {
    return lookupHfModel(repo)
  }

  /**
   * Switch llama-server's model. A new Hugging Face model is downloaded by llama-server itself on
   * start (progress in its log). Once it answers again, every running sandbox gets a fresh OpenCode
   * config for the new model (name, vision on/off).
   */
  async switchModel(spec: string): Promise<{ ok: boolean; message: string }> {
    const unit = this.settings.get().llama.systemdUnit
    try {
      const r = await switchModel(unit, spec, { singleSlot: this.settings.get().llama.singleSlot })
      if (this.settings.get().llama.modelName) this.settings.update({ llama: { modelName: '' } })
      void this.reconfigureAfterModelSwitch()
      return { ok: true, message: r.dropin ? `Switched to ${spec}. llama-server is restarting (and downloading the model if it's new).` : `Restored the original model ${spec}.` }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async graphInfo(projectId: string): Promise<{ exists: boolean; builtAt: number | null; url: string }> {
    const file = path.join(this.projects.get(projectId).path, 'graphify-out', 'graph.html')
    let builtAt: number | null = null
    try {
      builtAt = statSync(file).mtimeMs
    } catch {
      builtAt = null
    }
    return { exists: builtAt !== null, builtAt, url: `lf-graph://project/${projectId}/graph.html` }
  }

  async buildGraph(projectId: string): Promise<{ ok: boolean; message: string }> {
    try {
      await this.conn(projectId) // the sandbox must be running
      const out = await this.sandboxes.sh(projectId, 'cd /workspace && graphify update . 2>&1 | tail -n 4', 20 * 60_000)
      const { exists } = await this.graphInfo(projectId)
      return exists ? { ok: true, message: 'Map updated.' } : { ok: false, message: `graphify did not produce a map:\n${out.trim()}` }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async setSingleSlot(on: boolean): Promise<{ ok: boolean; message: string }> {
    try {
      this.settings.update({ llama: { singleSlot: on } })
      await applyServerOptions(this.settings.get().llama.systemdUnit, { singleSlot: on })
      void this.reconfigureAfterModelSwitch()
      return { ok: true, message: on ? 'llama-server is restarting with one conversation at a time.' : 'llama-server is restarting with its automatic number of slots.' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  private async reconfigureAfterModelSwitch(): Promise<void> {
    const deadline = Date.now() + 2 * 60 * 60 * 1000 // big downloads can take a while
    await new Promise((r) => setTimeout(r, 3000))
    while (Date.now() < deadline) {
      const st = await this.llamaStatus()
      if (st.up) break
      await new Promise((r) => setTimeout(r, 3000))
    }
    const st = await this.llamaStatus()
    if (!st.up) return
    this.send({ type: 'toast', level: 'success', message: `Model ready: ${st.modelAlias ?? 'llama-server'}` })
    for (const id of this.conns.keys()) {
      const p = this.projects.find(id)
      if (p) await this.sandboxes.writeOpenCodeConfig(id, await this.openCodeConfigFor(p)).catch(() => {})
    }
  }

  imageState(): ImageBuildState {
    return this.images.state
  }

  async buildImage(): Promise<void> {
    await this.images.ensure()
  }

  // ---------------------------------------------------------------------------------------------
  // Terminal (OpenCode PTY inside the sandbox)

  async ptyOpen(projectId: string, cols: number, rows: number): Promise<string> {
    const conn = await this.conn(projectId)
    const id = await conn.ptyCreate(cols, rows)
    const handle = await conn.ptyConnect(
      id,
      (data) => this.send({ type: 'pty-data', ptyId: id, data }),
      () => {
        this.ptys.delete(id)
        this.send({ type: 'pty-exit', ptyId: id })
      },
    )
    this.ptys.set(id, { projectId, ...handle })
    return id
  }

  ptyInput(ptyId: string, data: string): void {
    this.ptys.get(ptyId)?.send(data)
  }

  async ptyResize(ptyId: string, cols: number, rows: number): Promise<void> {
    const p = this.ptys.get(ptyId)
    if (!p) return
    await (await this.conn(p.projectId)).ptyResize(ptyId, cols, rows).catch(() => {})
  }

  async ptyClose(ptyId: string): Promise<void> {
    const p = this.ptys.get(ptyId)
    if (!p) return
    p.close()
    this.ptys.delete(ptyId)
    await (await this.conn(p.projectId)).ptyRemove(ptyId).catch(() => {})
  }

  // ---------------------------------------------------------------------------------------------
  // Settings

  getSettings(): Settings {
    return this.settings.get()
  }

  updateSettings(patch: DeepPartial<Settings>): Settings {
    return this.settings.update(patch)
  }
}

export function shortTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? one.slice(0, 57) + '...' : one || 'New session'
}

export function prettyModelName(id: string): string {
  // "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M" -> "Qwen3.8-27B (UD-Q4_K_M)"
  const base = id.split('/').pop() ?? id
  const [model, quant] = base.split(':')
  const m = model.replace(/-GGUF$/i, '')
  return quant ? `${m} (${quant})` : m
}
