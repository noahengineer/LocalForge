import { create } from 'zustand'
import type {
  BackendEvent,
  Checkpoint,
  CreateProgress,
  ImageBuildState,
  OcMessage,
  OcSession,
  PermissionRequest,
  Project,
  QuestionRequest,
  SandboxStatus,
  TemplateInfo,
} from '@shared/api'
import type { Settings } from '@shared/settings'
import type { HardwareSample, LlamaServerStatus, LlmRequestStats, MessageStats, TotalsStats } from '@shared/stats'
import { api, errMsg, onBackendEvent } from './api'

export type RightTab = 'desktop' | 'files' | 'changes' | 'terminal' | 'map' | 'hardware'

export interface QueuedPrompt {
  id: string
  text: string
  agent: 'build' | 'plan'
  files: Array<{ path: string }>
  images: Array<{ mime: string; dataUrl: string; filename?: string }>
}

export interface Toast {
  id: number
  level: 'info' | 'error' | 'success'
  message: string
}

interface State {
  ready: boolean
  settings: Settings | null
  templates: TemplateInfo[]
  projects: Project[]
  projectId: string | null
  sessionId: string | null
  sessions: Record<string, OcSession[]>
  sessionsLoading: Record<string, boolean>
  messages: Record<string, OcMessage[]>
  sessionStatus: Record<string, string>
  sandbox: Record<string, SandboxStatus>
  ocConnected: Record<string, boolean>
  llama: LlamaServerStatus | null
  image: ImageBuildState | null
  createProgress: CreateProgress | null
  live: Record<string, LlmRequestStats & { receivedAt: number }>
  lastBySession: Record<string, LlmRequestStats>
  msgStats: Record<string, { stats: MessageStats; requests: LlmRequestStats[] }>
  totals: Record<string, { session: TotalsStats; project: TotalsStats }>
  hardware: HardwareSample[]
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  checkpoints: Record<string, Checkpoint[]>
  queue: Record<string, QueuedPrompt[]>
  compactions: Record<string, number>
  toasts: Toast[]
  agentMode: 'build' | 'plan'
  rightTab: RightTab
  rightOpen: boolean
  sidebarOpen: boolean
  sidebarWidth: number
  rightWidth: number
  showSettings: boolean
  showNewProject: boolean
  newProjectMode: 'new' | 'import'
  connectError: Record<string, string | null>
}

/** Panel sizes and open/closed state: a per-window convenience, kept in localStorage. */
const LAYOUT_KEY = 'lf.layout'
const LAYOUT_DEFAULTS = { rightOpen: true, sidebarOpen: true, sidebarWidth: 264, rightWidth: 600 }
function loadLayout(): typeof LAYOUT_DEFAULTS {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<typeof LAYOUT_DEFAULTS>
    return {
      rightOpen: typeof v.rightOpen === 'boolean' ? v.rightOpen : LAYOUT_DEFAULTS.rightOpen,
      sidebarOpen: typeof v.sidebarOpen === 'boolean' ? v.sidebarOpen : LAYOUT_DEFAULTS.sidebarOpen,
      sidebarWidth: Number.isFinite(v.sidebarWidth) ? Number(v.sidebarWidth) : LAYOUT_DEFAULTS.sidebarWidth,
      rightWidth: Number.isFinite(v.rightWidth) ? Number(v.rightWidth) : LAYOUT_DEFAULTS.rightWidth,
    }
  } catch {
    return { ...LAYOUT_DEFAULTS }
  }
}

export const useStore = create<State>(() => ({
  ready: false,
  settings: null,
  templates: [],
  projects: [],
  projectId: null,
  sessionId: null,
  sessions: {},
  sessionsLoading: {},
  messages: {},
  sessionStatus: {},
  sandbox: {},
  ocConnected: {},
  llama: null,
  image: null,
  createProgress: null,
  live: {},
  lastBySession: {},
  msgStats: {},
  totals: {},
  hardware: [],
  permissions: [],
  questions: [],
  checkpoints: {},
  queue: {},
  compactions: {},
  toasts: [],
  agentMode: 'build',
  rightTab: 'desktop',
  ...loadLayout(),
  showSettings: false,
  showNewProject: false,
  newProjectMode: 'new',
  connectError: {},
}))

const set = useStore.setState
const get = useStore.getState

let toastId = 1
export function toast(level: Toast['level'], message: string): void {
  const t = { id: toastId++, level, message }
  set((s) => ({ toasts: [...s.toasts, t].slice(-5) }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), level === 'error' ? 9000 : 4500)
}

export const totalsKey = (projectId: string, sessionId: string | null) => `${projectId}:${sessionId ?? ''}`

// ------------------------------------------------------------------------------------------------
// Message list helpers (immutable updates)

function upsertMessageInfo(list: OcMessage[], info: OcMessage['info']): OcMessage[] {
  const i = list.findIndex((m) => m.info.id === info.id)
  if (i < 0) {
    const next = [...list, { info, parts: [] }]
    next.sort((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
    return next
  }
  const next = [...list]
  next[i] = { ...next[i], info }
  return next
}

function upsertPart(list: OcMessage[], part: OcMessage['parts'][number]): OcMessage[] {
  let i = list.findIndex((m) => m.info.id === part.messageID)
  let next = list
  if (i < 0) {
    next = upsertMessageInfo(list, { id: part.messageID, sessionID: part.sessionID, role: 'assistant', time: { created: Date.now() } })
    i = next.findIndex((m) => m.info.id === part.messageID)
  } else next = [...list]
  const msg = next[i]
  const pi = msg.parts.findIndex((p) => p.id === part.id)
  const parts = [...msg.parts]
  if (pi < 0) {
    parts.push(part)
    parts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  } else {
    // A full update replaces the streamed text unless it is the empty start-of-part snapshot.
    const prev = parts[pi]
    const keepText = (part.type === 'text' || part.type === 'reasoning') && !part.text && prev.text
    parts[pi] = keepText ? { ...part, text: prev.text } : part
  }
  next[i] = { ...msg, parts }
  return next
}

function appendDelta(list: OcMessage[], messageID: string, partID: string, field: string, delta: string): OcMessage[] {
  const i = list.findIndex((m) => m.info.id === messageID)
  if (i < 0) return list
  const msg = list[i]
  const pi = msg.parts.findIndex((p) => p.id === partID)
  if (pi < 0) return list
  const parts = [...msg.parts]
  parts[pi] = { ...parts[pi], [field]: String(parts[pi][field] ?? '') + delta }
  const next = [...list]
  next[i] = { ...msg, parts }
  return next
}

// ------------------------------------------------------------------------------------------------
// Event reducer

function onOcEvent(projectId: string, ev: { type: string; properties: any }): void {
  const p = ev.properties ?? {}
  switch (ev.type) {
    case 'session.created':
    case 'session.updated': {
      const info = p.info as OcSession
      set((s) => {
        const list = s.sessions[projectId] ?? []
        const i = list.findIndex((x) => x.id === info.id)
        const next = i < 0 ? [info, ...list] : list.map((x) => (x.id === info.id ? info : x))
        return { sessions: { ...s.sessions, [projectId]: next } }
      })
      break
    }
    case 'session.deleted': {
      const id = p.info?.id ?? p.sessionID
      set((s) => ({ sessions: { ...s.sessions, [projectId]: (s.sessions[projectId] ?? []).filter((x) => x.id !== id) } }))
      break
    }
    case 'session.status':
      set((s) => ({ sessionStatus: { ...s.sessionStatus, [p.sessionID]: p.status?.type ?? 'idle' } }))
      break
    case 'session.idle':
      set((s) => ({ sessionStatus: { ...s.sessionStatus, [p.sessionID]: 'idle' } }))
      flushQueue(projectId, p.sessionID)
      if (get().rightTab === 'changes') void refreshCheckpoints(projectId)
      break
    case 'session.compacted':
      set((s) => ({ compactions: { ...s.compactions, [p.sessionID]: Date.now() } }))
      break
    case 'session.error': {
      const e = p.error
      const name = e?.name ?? e?._tag ?? ''
      if (!/Aborted/i.test(name)) toast('error', `Agent error: ${e?.data?.message ?? e?.message ?? name ?? 'unknown'}`)
      break
    }
    case 'message.updated': {
      const info = p.info
      if (!get().messages[info.sessionID]) break
      set((s) => ({ messages: { ...s.messages, [info.sessionID]: upsertMessageInfo(s.messages[info.sessionID] ?? [], info) } }))
      break
    }
    case 'message.removed':
      if (!get().messages[p.sessionID]) break
      set((s) => ({ messages: { ...s.messages, [p.sessionID]: (s.messages[p.sessionID] ?? []).filter((m) => m.info.id !== p.messageID) } }))
      break
    case 'message.part.updated': {
      const part = p.part
      if (!get().messages[part.sessionID]) break
      if (part.type === 'compaction') set((s) => ({ compactions: { ...s.compactions, [part.sessionID]: Date.now() } }))
      set((s) => ({ messages: { ...s.messages, [part.sessionID]: upsertPart(s.messages[part.sessionID] ?? [], part) } }))
      break
    }
    case 'message.part.delta': {
      if (!get().messages[p.sessionID]) break
      set((s) => ({ messages: { ...s.messages, [p.sessionID]: appendDelta(s.messages[p.sessionID] ?? [], p.messageID, p.partID, p.field, p.delta) } }))
      break
    }
    case 'message.part.removed':
      if (!get().messages[p.sessionID]) break
      set((s) => ({
        messages: {
          ...s.messages,
          [p.sessionID]: (s.messages[p.sessionID] ?? []).map((m) => (m.info.id === p.messageID ? { ...m, parts: m.parts.filter((x) => x.id !== p.partID) } : m)),
        },
      }))
      break
    case 'permission.asked':
      set((s) => ({ permissions: [...s.permissions.filter((x) => x.id !== p.id), p as PermissionRequest] }))
      break
    case 'permission.replied':
      set((s) => ({ permissions: s.permissions.filter((x) => x.id !== p.requestID) }))
      break
    case 'question.asked':
      set((s) => ({ questions: [...s.questions.filter((x) => x.id !== p.id), p as QuestionRequest] }))
      break
    case 'question.replied':
    case 'question.rejected':
      set((s) => ({ questions: s.questions.filter((x) => x.id !== p.requestID) }))
      break
    default:
      break
  }
}

function onEvent(ev: BackendEvent): void {
  switch (ev.type) {
    case 'oc':
      onOcEvent(ev.projectId, ev.event)
      break
    case 'oc-connection':
      set((s) => ({ ocConnected: { ...s.ocConnected, [ev.projectId]: ev.connected } }))
      if (ev.connected && ev.projectId === get().projectId) void resyncProject(ev.projectId)
      break
    case 'llm-start':
    case 'llm-update':
      set((s) => ({ live: { ...s.live, [ev.stats.id]: { ...ev.stats, receivedAt: Date.now() } } }))
      break
    case 'llm-end': {
      const st = ev.stats
      set((s) => {
        const live = { ...s.live }
        delete live[st.id]
        const lastBySession = { ...s.lastBySession }
        if (st.sessionId && st.kind === 'agent' && st.usage) lastBySession[st.sessionId] = st
        return { live, lastBySession }
      })
      break
    }
    case 'message-stats':
      set((s) => ({ msgStats: { ...s.msgStats, [ev.messageId]: { stats: ev.stats, requests: ev.requests } } }))
      break
    case 'totals':
      set((s) => ({
        totals: {
          ...s.totals,
          [totalsKey(ev.projectId, ev.sessionId)]: { session: ev.session, project: ev.project },
          [totalsKey(ev.projectId, null)]: { session: ev.project, project: ev.project },
        },
      }))
      break
    case 'hardware':
      set((s) => {
        const h = [...s.hardware, ev.sample]
        const cutoff = ev.sample.t - 5 * 60 * 1000
        while (h.length && h[0].t < cutoff) h.shift()
        return { hardware: h }
      })
      break
    case 'llama-status':
      set({ llama: ev.status })
      break
    case 'sandbox-status':
      set((s) => ({ sandbox: { ...s.sandbox, [ev.status.projectId]: ev.status } }))
      break
    case 'image-build':
      set({ image: ev.state })
      break
    case 'create-progress':
      set({ createProgress: ev.progress })
      break
    case 'projects':
      set({ projects: ev.projects })
      break
    case 'checkpoint':
      set((s) => ({ checkpoints: { ...s.checkpoints, [ev.projectId]: [ev.checkpoint, ...(s.checkpoints[ev.projectId] ?? [])] } }))
      break
    case 'settings':
      set({ settings: ev.settings })
      applyTheme(ev.settings)
      break
    case 'toast':
      toast(ev.level, ev.message)
      break
    default:
      break
  }
}

// ------------------------------------------------------------------------------------------------
// Actions

export function applyTheme(s: Settings | null): void {
  const theme = s?.ui.theme ?? 'dark'
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('light', !dark)
}

export async function initStore(): Promise<void> {
  onBackendEvent(onEvent)
  const [settings, projects, templates, llama, image, hardware, active] = await Promise.all([
    api.getSettings(),
    api.listProjects(),
    api.listTemplates(),
    api.llamaStatus().catch(() => null),
    api.imageState().catch(() => null),
    api.hardwareHistory().catch(() => []),
    api.activeRequests().catch(() => []),
  ])
  applyTheme(settings)
  const live: State['live'] = {}
  for (const r of active) live[r.id] = { ...r, receivedAt: Date.now() }
  set({ settings, projects, templates, llama, image, hardware, live, ready: true })
  if (projects.length > 0) await selectProject(projects[0].id, projects[0].lastSessionId)
}

export async function selectProject(projectId: string, sessionId?: string | null): Promise<void> {
  set((s) => ({ projectId, sessionId: sessionId ?? null, connectError: { ...s.connectError, [projectId]: null } }))
  try {
    await api.startSandbox(projectId)
    await resyncProject(projectId)
    const sessions = get().sessions[projectId] ?? []
    const wanted = sessionId ?? get().projects.find((p) => p.id === projectId)?.lastSessionId ?? null
    const target = sessions.find((x) => x.id === wanted) ?? sessions.find((x) => !x.parentID)
    if (get().projectId === projectId) {
      if (target) await selectSession(target.id)
      else await newSession()
    }
  } catch (e) {
    set((s) => ({ connectError: { ...s.connectError, [projectId]: errMsg(e) } }))
  }
}

/** Reload sessions, statuses and pending prompts for a project (after (re)connect). */
export async function resyncProject(projectId: string): Promise<void> {
  set((s) => ({ sessionsLoading: { ...s.sessionsLoading, [projectId]: true } }))
  try {
    const [sessions, status, pending, totals] = await Promise.all([
      api.listSessions(projectId),
      api.getSessionStatus(projectId).catch(() => ({}) as Record<string, { type: string }>),
      api.pendingRequests(projectId).catch(() => ({ permissions: [], questions: [] })),
      api.getTotals(projectId, null).catch(() => null),
    ])
    const st: Record<string, string> = {}
    for (const [k, v] of Object.entries(status)) st[k] = v.type
    set((s) => ({
      sessions: { ...s.sessions, [projectId]: sessions },
      sessionStatus: { ...s.sessionStatus, ...st },
      permissions: [...s.permissions.filter((x) => !pending.permissions.some((p) => p.id === x.id)), ...pending.permissions],
      questions: [...s.questions.filter((x) => !pending.questions.some((p) => p.id === x.id)), ...pending.questions],
      totals: totals ? { ...s.totals, [totalsKey(projectId, null)]: totals } : s.totals,
    }))
    const sid = get().sessionId
    if (sid && get().projectId === projectId) await loadSession(projectId, sid)
  } finally {
    set((s) => ({ sessionsLoading: { ...s.sessionsLoading, [projectId]: false } }))
  }
}

async function loadSession(projectId: string, sessionId: string): Promise<void> {
  const [msgs, stats, totals] = await Promise.all([
    api.getMessages(projectId, sessionId),
    api.getMessageStats(projectId, sessionId).catch(() => ({})),
    api.getTotals(projectId, sessionId).catch(() => null),
  ])
  set((s) => {
    const lastBySession = { ...s.lastBySession }
    // Context usage = the last finished main-agent request of this session.
    const reqs = Object.values(stats)
      .flatMap((x) => x.requests)
      .filter((r) => r.sessionId === sessionId && r.kind === 'agent' && r.usage)
      .sort((a, b) => a.startedAt - b.startedAt)
    if (reqs.length) lastBySession[sessionId] = reqs[reqs.length - 1]
    return {
      messages: { ...s.messages, [sessionId]: msgs },
      msgStats: { ...s.msgStats, ...stats },
      lastBySession,
      totals: totals ? { ...s.totals, [totalsKey(projectId, sessionId)]: totals } : s.totals,
    }
  })
}

export async function selectSession(sessionId: string): Promise<void> {
  const projectId = get().projectId
  if (!projectId) return
  set({ sessionId })
  try {
    await loadSession(projectId, sessionId)
  } catch (e) {
    toast('error', `Could not load session: ${errMsg(e)}`)
  }
}

export async function newSession(): Promise<void> {
  const projectId = get().projectId
  if (!projectId) return
  try {
    const s = await api.createSession(projectId)
    set((st) => ({
      sessions: { ...st.sessions, [projectId]: [s, ...(st.sessions[projectId] ?? []).filter((x) => x.id !== s.id)] },
      messages: { ...st.messages, [s.id]: [] },
      sessionId: s.id,
    }))
  } catch (e) {
    toast('error', `Could not create session: ${errMsg(e)}`)
  }
}

export function isBusy(sessionId: string | null): boolean {
  if (!sessionId) return false
  const st = get().sessionStatus[sessionId]
  return st === 'busy' || st === 'retry'
}

export async function sendPrompt(q: Omit<QueuedPrompt, 'id'>): Promise<void> {
  const { projectId, sessionId } = get()
  if (!projectId || !sessionId) return
  await sendPromptTo(projectId, sessionId, q)
}

/** Send now, or queue it if the session is busy (queued prompts go out when it becomes idle). */
export async function sendPromptTo(projectId: string, sessionId: string, q: Omit<QueuedPrompt, 'id'>): Promise<void> {
  if (isBusy(sessionId)) {
    const item: QueuedPrompt = { ...q, id: `q${Date.now()}${Math.random().toString(36).slice(2, 6)}` }
    set((s) => ({ queue: { ...s.queue, [sessionId]: [...(s.queue[sessionId] ?? []), item] } }))
    return
  }
  set((s) => ({ sessionStatus: { ...s.sessionStatus, [sessionId]: 'busy' } }))
  try {
    await api.prompt({ projectId, sessionId, text: q.text, agent: q.agent, files: q.files, images: q.images })
  } catch (e) {
    set((s) => ({ sessionStatus: { ...s.sessionStatus, [sessionId]: 'idle' } }))
    toast('error', `Send failed: ${errMsg(e)}`)
  }
}

function flushQueue(projectId: string, sessionId: string): void {
  const q = get().queue[sessionId]
  if (!q?.length) return
  const [next, ...rest] = q
  set((s) => ({ queue: { ...s.queue, [sessionId]: rest } }))
  void sendPromptTo(projectId, sessionId, next)
}

export function removeQueued(sessionId: string, id: string): void {
  set((s) => ({ queue: { ...s.queue, [sessionId]: (s.queue[sessionId] ?? []).filter((x) => x.id !== id) } }))
}

export async function stopSession(): Promise<void> {
  const { projectId, sessionId } = get()
  if (!projectId || !sessionId) return
  try {
    await api.abort(projectId, sessionId)
  } catch (e) {
    toast('error', `Stop failed: ${errMsg(e)}`)
  }
}

export async function refreshCheckpoints(projectId: string): Promise<void> {
  try {
    const cps = await api.listCheckpoints(projectId)
    set((s) => ({ checkpoints: { ...s.checkpoints, [projectId]: cps } }))
  } catch {
    /* sandbox not running */
  }
}

export async function updateSettings(patch: Parameters<typeof api.updateSettings>[0]): Promise<void> {
  const s = await api.updateSettings(patch)
  set({ settings: s })
  applyTheme(s)
}

useStore.subscribe((s, prev) => {
  if (s.rightOpen === prev.rightOpen && s.sidebarOpen === prev.sidebarOpen && s.sidebarWidth === prev.sidebarWidth && s.rightWidth === prev.rightWidth) return
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ rightOpen: s.rightOpen, sidebarOpen: s.sidebarOpen, sidebarWidth: s.sidebarWidth, rightWidth: s.rightWidth }))
  } catch {
    /* storage unavailable: layout just isn't remembered */
  }
})
