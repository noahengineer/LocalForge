import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { configDir } from './paths'

/** Encrypts keys at rest; in the app this is Electron's safeStorage (the OS keyring). */
export interface KeyCipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

type Entry = { enc: string } | { plain: string }

/**
 * API keys, one per provider, in ~/.config/LocalForge/api-keys.json (mode 600). Encrypted with the
 * OS keyring when one is available, otherwise stored as plain text (still owner-only). Keys never
 * go to the renderer or into a sandbox: only the stats proxy reads them, to add the Authorization
 * header on its way out.
 */
export class ApiKeyStore {
  private entries: Record<string, Entry> = {}

  constructor(
    private readonly cipher: KeyCipher | null,
    readonly file = path.join(configDir(), 'api-keys.json'),
  ) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>
      if (j && typeof j === 'object') this.entries = j
    } catch {
      this.entries = {}
    }
  }

  /** True when keys are encrypted with the OS keyring. */
  get encrypted(): boolean {
    return !!this.cipher?.available()
  }

  has(providerId: string): boolean {
    return !!this.entries[providerId]
  }

  get(providerId: string): string | null {
    const e = this.entries[providerId]
    if (!e) return null
    if ('plain' in e) return e.plain
    try {
      return this.cipher ? this.cipher.decrypt(Buffer.from(e.enc, 'base64')) : null
    } catch {
      return null
    }
  }

  /** Save a key ('' removes it). */
  set(providerId: string, key: string): void {
    const k = key.trim()
    if (!k) delete this.entries[providerId]
    else if (this.encrypted) this.entries[providerId] = { enc: this.cipher!.encrypt(k).toString('base64') }
    else this.entries[providerId] = { plain: k }
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}
