import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** ~/.config/LocalForge (same as Electron's userData for productName "LocalForge"). */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'LocalForge')
}

/** ~/.local/share/localforge: project registry, stats history. */
export function dataDir(): string {
  if (process.env.LOCALFORGE_DATA_DIR) return process.env.LOCALFORGE_DATA_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'localforge')
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

let appFilesRoot: { templates: string; sandbox: string } | null = null

/**
 * Where the shipped templates and the sandbox build context live. In the packaged app these are
 * electron-builder extraResources (process.resourcesPath/{templates,sandbox}); in development
 * they are in the repository.
 */
export function setAppFiles(dirs: { templates: string; sandbox: string }): void {
  appFilesRoot = dirs
}

/** Repository root when running from source (tsx/vitest) or from out/main (electron-vite). */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'sandbox', 'Containerfile'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return process.cwd()
}

export function templatesDir(): string {
  return appFilesRoot?.templates ?? path.join(repoRoot(), 'resources', 'templates')
}

export function sandboxDir(): string {
  return appFilesRoot?.sandbox ?? path.join(repoRoot(), 'sandbox')
}
