import { contextBridge, ipcRenderer, webUtils } from 'electron'

type Listener = (ev: unknown) => void

contextBridge.exposeInMainWorld('lf', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('api', method, args),
  onEvent: (cb: Listener) => {
    const handler = (_e: unknown, ev: unknown) => cb(ev)
    ipcRenderer.on('backend-event', handler)
    return () => ipcRenderer.removeListener('backend-event', handler)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
})
