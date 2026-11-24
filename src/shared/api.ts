/** Types shared by the backend (Electron main) and the UI (renderer). */
import type { HardwareSample, LlamaServerStatus, LlmRequestStats, MessageStats, TotalsStats } from './stats'
import type { DeepPartial, Settings } from './settings'

export type TemplateId = 'empty' | 'cpp' | 'react-ts' | 'node' | 'python' | 'rust' | 'electron'

export interface TemplateInfo {
  id: TemplateId
  name: string
  description: string
  commands: { setup?: string; build?: string; test?: string; run?: string; dev?: string }
}

export interface Project {
  id: string
  name: string
  path: string
  /** Template it was created from, or 'imported' for an existing folder opened in place. */
  template: TemplateId | 'imported'
  description: string
  createdAt: number
  /** Session to open by default. */
  lastSessionId: string | null
  /** Commit that checkpoints start from (Undo never goes further back). */
  baseCommit?: string | null
  /** Per-project switch for auto-checkpoints (imported projects can opt out). Default true. */
  checkpoints?: boolean
  /**
   * The project has its own AGENTS.md/CLAUDE.md, so LocalForge's rules are given to the agent through
   * the sandbox's global ~/.config/opencode/AGENTS.md instead of a file in the project.
   */
  rulesInSandbox?: boolean
  /** Detected stack, for imported projects. */
  stack?: DetectedStack
}

export interface DetectedStack {
  kinds: string[]
  commands: { setup?: string; build?: string; test?: string; run?: string }
  notes: string[]
}

/** What the import dialog shows about a folder before anything is changed. */
export interface FolderInspection {
  path: string
  ok: boolean
  error: string | null
  warnings: string[]
  suggestedName: string
  git: { kind: 'none' | 'repo' | 'linked' | 'parent'; branch: string | null; head: string | null; parentRepo: string | null }
  instructionsFile: 'AGENTS.md' | 'CLAUDE.md' | 'CONTEXT.md' | null
  stack: DetectedStack
  fileCount: number
  existingProjectId: string | null
}

export interface Todo {
  content: string
  /** pending | in_progress | completed | cancelled */
  status: string
  priority?: string
  id?: string
}

export interface CachedModel {
  /** What to pass to switchModel: "org/repo:QUANT" for Hugging Face cache entries, or a .gguf path. */
  spec: string
  repo: string | null
  file: string
  path: string
  sizeBytes: number
  /** A vision projector (mmproj) is available, so the model can see images. */
  vision: boolean
}

export interface ModelsInfo {
  unitPath: string | null
  /** Model the service runs now (-hf spec or file path). */
  current: string | null
  /** Model in the user's own unit file. */
  original: string | null
  /** LocalForge's drop-in is active. */
  overridden: boolean
  cached: CachedModel[]
  cacheDir: string
  freeBytes: number | null
  /** -np in the configured command line (null = llama-server's automatic, currently 4 slots). */
  parallel: number | null
  error: string | null
}

export interface HfModelInfo {
  repo: string
  gated: boolean
  vision: boolean
  quants: Array<{ quant: string; sizeBytes: number; spec: string }>
}

export interface ImportProjectInput {
  path: string
  name: string
  description: string
  /** Use git checkpoints (git init if needed, snapshot uncommitted work, commit after each turn). */
  checkpoints: boolean
  /** Build the graphify knowledge graph. */
  graph: boolean
}

export type SandboxState = 'missing' | 'creating' | 'starting' | 'running' | 'stopped' | 'error'

export interface SandboxStatus {
  projectId: string
  state: SandboxState
  container: string
  image: string | null
  opencodePort: number | null
  novncPort: number | null
  opencodeReady: boolean
  cpuPct: number | null
  memUsedMiB: number | null
  memLimitMiB: number | null
  error: string | null
}

export interface ImageBuildState {
  status: 'unknown' | 'missing' | 'building' | 'ready' | 'error'
  tag: string | null
  step: number
  totalSteps: number
  stepText: string
  log: string[]
  error: string | null
}

export interface CreateProjectInput {
  name: string
  template: TemplateId
  description: string
}

export interface CreateStep {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  detail?: string
}

export interface CreateProgress {
  name: string
  steps: CreateStep[]
  done: boolean
  error: string | null
  projectId: string | null
  sessionId: string | null
}

export interface Checkpoint {
  commit: string
  shortCommit: string
  subject: string
  time: number
  sessionId: string | null
  /** The user message that started the turn this checkpoint closes. */
  messageId: string | null
}

export interface ChangesInfo {
  baseCommit: string | null
  baseSubject: string | null
  files: Array<{ path: string; status: string; additions: number; deletions: number }>
  diff: string
}

export interface FileNode {
  name: string
  path: string // relative to project root
  type: 'file' | 'dir' | 'symlink'
  size?: number
  /** Heavy/generated folder (node_modules, build, .git...), shown collapsed and dimmed. */
  heavy?: boolean
}

export interface FileContent {
  path: string
  content: string | null
  binary: boolean
  size: number
  truncated: boolean
  mime: string | null
  dataUrl: string | null
}

/** OpenCode message with parts, as returned by GET /session/:id/message. Kept loose on purpose. */
export interface OcMessage {
  info: Record<string, any> & { id: string; role: 'user' | 'assistant'; sessionID: string }
  parts: Array<Record<string, any> & { id: string; type: string }>
}

export interface OcSession {
  id: string
  title: string
  parentID?: string
  time: { created: number; updated: number }
  revert?: { messageID: string; partID?: string } | null
  [k: string]: unknown
}

export interface PromptInput {
  projectId: string
  sessionId: string
  text: string
  agent: 'build' | 'plan'
  files?: Array<{ path: string }>
  images?: Array<{ mime: string; dataUrl: string; filename?: string }>
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean }>
}

/** Events pushed from the backend to the UI. */
export type BackendEvent =
  | { type: 'oc'; projectId: string; event: { type: string; properties: any } }
  | { type: 'oc-connection'; projectId: string; connected: boolean }
  | { type: 'llm-start' | 'llm-update' | 'llm-end'; stats: LlmRequestStats }
  | { type: 'message-stats'; projectId: string; sessionId: string; messageId: string; stats: MessageStats; requests: LlmRequestStats[] }
  | { type: 'totals'; projectId: string; sessionId: string | null; session: TotalsStats; project: TotalsStats }
  | { type: 'hardware'; sample: HardwareSample }
  | { type: 'llama-status'; status: LlamaServerStatus }
  | { type: 'sandbox-status'; status: SandboxStatus }
  | { type: 'image-build'; state: ImageBuildState }
  | { type: 'create-progress'; progress: CreateProgress }
  | { type: 'projects'; projects: Project[] }
  | { type: 'checkpoint'; projectId: string; checkpoint: Checkpoint }
  | { type: 'settings'; settings: Settings }
  | { type: 'pty-data'; ptyId: string; data: string }
  | { type: 'pty-exit'; ptyId: string }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; message: string }

/** Methods the UI can call on the backend (via IPC). */
export interface BackendApi {
  getSettings(): Promise<Settings>
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  listTemplates(): Promise<TemplateInfo[]>

  listProjects(): Promise<Project[]>
  createProject(input: CreateProjectInput): Promise<{ projectId: string; sessionId: string | null }>
  /** Inspect a folder for importing (read-only). */
  inspectFolder(path: string): Promise<FolderInspection>
  /** Open an existing folder as a project, in place. Progress is streamed as 'create-progress'. */
  importProject(input: ImportProjectInput): Promise<{ projectId: string; sessionId: string | null }>
  /** Native folder picker (Electron). */
  pickFolder(): Promise<string | null>
  removeProject(projectId: string, deleteFiles: boolean): Promise<void>
  openProjectFolder(projectId: string): Promise<void>

  imageState(): Promise<ImageBuildState>
  buildImage(): Promise<void>

  sandboxStatus(projectId: string): Promise<SandboxStatus>
  startSandbox(projectId: string): Promise<SandboxStatus>
  stopSandbox(projectId: string): Promise<void>
  resetSandbox(projectId: string): Promise<SandboxStatus>

  listSessions(projectId: string): Promise<OcSession[]>
  createSession(projectId: string, title?: string): Promise<OcSession>
  deleteSession(projectId: string, sessionId: string): Promise<void>
  renameSession(projectId: string, sessionId: string, title: string): Promise<void>
  getMessages(projectId: string, sessionId: string): Promise<OcMessage[]>
  /** The agent's task list for a session (OpenCode's todowrite). */
  getTodos(projectId: string, sessionId: string): Promise<Todo[]>
  getSessionStatus(projectId: string): Promise<Record<string, { type: string }>>
  prompt(input: PromptInput): Promise<void>
  abort(projectId: string, sessionId: string): Promise<void>
  replyPermission(projectId: string, requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void>
  replyQuestion(projectId: string, requestId: string, answers: string[][]): Promise<void>
  rejectQuestion(projectId: string, requestId: string): Promise<void>
  pendingRequests(projectId: string): Promise<{ permissions: PermissionRequest[]; questions: QuestionRequest[] }>
  findFiles(projectId: string, query: string): Promise<string[]>

  getMessageStats(projectId: string, sessionId: string): Promise<Record<string, { stats: MessageStats; requests: LlmRequestStats[] }>>
  getTotals(projectId: string, sessionId: string | null): Promise<{ session: TotalsStats; project: TotalsStats }>
  activeRequests(): Promise<LlmRequestStats[]>
  hardwareHistory(): Promise<HardwareSample[]>

  listCheckpoints(projectId: string): Promise<Checkpoint[]>
  undoToCheckpoint(projectId: string, sessionId: string | null, commit: string): Promise<void>
  /**
   * Rewind to just before one of your messages (conversation and files) and send it again:
   * unchanged (retry) or with new text (edit). Later messages are removed.
   */
  rerunMessage(projectId: string, sessionId: string, messageId: string, newText: string | null): Promise<void>
  getChanges(projectId: string): Promise<ChangesInfo>

  /** Direct children of a directory (relative path, '' = project root). */
  listDir(projectId: string, relPath: string): Promise<FileNode[]>
  readFile(projectId: string, relPath: string): Promise<FileContent>

  llamaStatus(): Promise<LlamaServerStatus>
  llamaControl(action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; message: string }>
  llamaLogs(): Promise<string>
  modelsInfo(): Promise<ModelsInfo>
  lookupHfModel(repo: string): Promise<HfModelInfo>
  /** Switch llama-server to another model (downloads it first if it's a new Hugging Face spec). */
  switchModel(spec: string): Promise<{ ok: boolean; message: string }>
  /** The project's graphify map (graphify-out/graph.html). */
  graphInfo(projectId: string): Promise<{ exists: boolean; builtAt: number | null; url: string }>
  /** Build or refresh the map with `graphify update .` in the sandbox (no AI needed). */
  buildGraph(projectId: string): Promise<{ ok: boolean; message: string }>
  /** Turn one-conversation-at-a-time on/off (restarts llama-server). */
  setSingleSlot(on: boolean): Promise<{ ok: boolean; message: string }>
  /** Which API providers have a key saved (keys themselves never leave the main process). */
  apiKeyStatus(): Promise<{ keys: Record<string, boolean>; encrypted: boolean }>
  /** Save a provider's API key ('' removes it). */
  setApiKey(providerId: string, key: string): Promise<void>
  /** Ask a provider which models it offers. */
  listApiModels(providerId: string): Promise<ApiModelInfo[]>

  ptyOpen(projectId: string, cols: number, rows: number): Promise<string>
  ptyInput(ptyId: string, data: string): Promise<void>
  ptyResize(ptyId: string, cols: number, rows: number): Promise<void>
  ptyClose(ptyId: string): Promise<void>
}

/** A model offered by an API provider (from its /models list). Unknown values are null. */
export interface ApiModelInfo {
  id: string
  name: string
  contextLimit: number | null
  outputLimit: number | null
  vision: boolean
  /** Whether it can call tools (the agent needs this); null = the provider doesn't say. */
  tools: boolean | null
}
