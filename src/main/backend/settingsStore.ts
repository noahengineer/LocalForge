import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configDir } from './paths'
import { defaultSettings, mergeSettings, type DeepPartial, type Settings } from '../../shared/settings'

export class SettingsStore extends EventEmitter<{ changed: [Settings, Settings] }> {
  private current: Settings
  readonly file: string

  constructor(file = path.join(configDir(), 'settings.json')) {
    super()
    this.file = file
    const defaults = defaultSettings(os.cpus().length)
    let loaded: unknown = {}
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      loaded = {}
    }
    this.current = mergeSettings(defaults, loaded)
  }

  get(): Settings {
    return structuredClone(this.current)
  }

  update(patch: DeepPartial<Settings>): Settings {
    const prev = this.current
    this.current = mergeSettings(prev, patch)
    this.save()
    this.emit('changed', this.get(), prev)
    return this.get()
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.current, null, 2))
    renameSync(tmp, this.file)
  }
}
