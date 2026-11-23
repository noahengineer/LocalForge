import type { BackendApi, BackendEvent } from '@shared/api'

interface LfBridge {
  call(method: string, ...args: unknown[]): Promise<unknown>
  onEvent(cb: (ev: BackendEvent) => void): () => void
  pathForFile(file: File): string
}

declare global {
  interface Window {
    lf: LfBridge
  }
}

/** Typed client for the backend running in Electron's main process. */
export const api: BackendApi = new Proxy({} as BackendApi, {
  get(_t, method: string) {
    return (...args: unknown[]) => window.lf.call(method, ...args)
  },
})

export function onBackendEvent(cb: (ev: BackendEvent) => void): () => void {
  return window.lf.onEvent(cb)
}

/** Strip Electron's "Error invoking remote method 'api': Error: " prefix. */
export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
