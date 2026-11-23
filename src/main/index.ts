import { app, BrowserWindow, dialog, ipcMain, Menu, shell, nativeImage } from 'electron'
import { handleGraphScheme, registerGraphScheme } from './graphProtocol'
import os from 'node:os'
import path from 'node:path'
import { Backend } from './backend/backend'
import { setAppFiles } from './backend/paths'
import type { BackendApi } from '../shared/api'

app.setName('LocalForge')

// Packaged app: templates and the sandbox build context are shipped as extraResources.
if (app.isPackaged) {
  setAppFiles({ templates: path.join(process.resourcesPath, 'templates'), sandbox: path.join(process.resourcesPath, 'sandbox') })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let backend: Backend | null = null
let win: BrowserWindow | null = null
let quitting = false

/** Backend methods the renderer may call (everything in BackendApi). */
const METHODS: Array<keyof BackendApi> = [
  'getSettings',
  'updateSettings',
  'listTemplates',
  'listProjects',
  'createProject',
  'inspectFolder',
  'importProject',
  'pickFolder',
  'removeProject',
  'openProjectFolder',
  'imageState',
  'buildImage',
  'sandboxStatus',
  'startSandbox',
  'stopSandbox',
  'resetSandbox',
  'listSessions',
  'createSession',
  'deleteSession',
  'renameSession',
  'getMessages',
  'getSessionStatus',
  'prompt',
  'abort',
  'replyPermission',
  'replyQuestion',
  'rejectQuestion',
  'pendingRequests',
  'findFiles',
  'getMessageStats',
  'getTotals',
  'activeRequests',
  'hardwareHistory',
  'listCheckpoints',
  'undoToCheckpoint',
  'rerunMessage',
  'getChanges',
  'listDir',
  'readFile',
  'llamaStatus',
  'llamaControl',
  'llamaLogs',
  'modelsInfo',
  'lookupHfModel',
  'switchModel',
  'graphInfo',
  'buildGraph',
  'setSingleSlot',
  'ptyOpen',
  'ptyInput',
  'ptyResize',
  'ptyClose',
]

function iconPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(import.meta.dirname, '../../build/icons/512x512.png')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    title: 'LocalForge',
    backgroundColor: '#1a1a19',
    icon: nativeImage.createFromPath(iconPath()),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  win.on('closed', () => {
    win = null
  })
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

registerGraphScheme()

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  backend = new Backend()
  const b = backend
  handleGraphScheme((id) => b.projects.find(id)?.path ?? null)
  b.on('event', (ev) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('backend-event', ev)
  })
  ipcMain.handle('api', async (_e, method: string, args: unknown[]) => {
    if (!METHODS.includes(method as keyof BackendApi)) throw new Error(`unknown method ${method}`)
    if (method === 'pickFolder') {
      const opts: Electron.OpenDialogOptions = { title: 'Open an existing project folder', defaultPath: os.homedir(), properties: ['openDirectory'] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    }
    if (method === 'openProjectFolder') {
      const p = b.projects.get(String(args[0]))
      await shell.openPath(p.path)
      return
    }
    const fn = (b as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
    return await fn.apply(b, args)
  })
  createWindow()
  await b.init()
})

app.on('before-quit', (e) => {
  if (quitting || !backend) return
  e.preventDefault()
  quitting = true
  const b = backend
  void Promise.race([b.shutdown(), new Promise((r) => setTimeout(r, 30_000))]).finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  app.quit()
})
