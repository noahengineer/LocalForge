import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { HardwareSample } from '../../shared/stats'

export const NVIDIA_QUERY = 'name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit'

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null
  const v = Number.parseFloat(s.trim())
  return Number.isFinite(v) ? v : null
}

/** Parse one line of `nvidia-smi --query-gpu=<NVIDIA_QUERY> --format=csv,noheader,nounits`. */
export function parseNvidiaLine(line: string): HardwareSample['gpu'] {
  const parts = line.split(',').map((p) => p.trim())
  if (parts.length < 7) return null
  const [name, used, total, util, temp, power, limit] = parts
  const vramUsed = num(used)
  const vramTotal = num(total)
  if (vramUsed === null || vramTotal === null) return null
  return {
    name,
    vramUsedMiB: vramUsed,
    vramTotalMiB: vramTotal,
    utilPct: num(util) ?? 0,
    tempC: num(temp) ?? 0,
    powerW: num(power) ?? 0,
    powerLimitW: num(limit),
  }
}

export interface CpuTimes {
  idle: number
  total: number
}

/** Parse the aggregate `cpu` line of /proc/stat. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '))
  if (!line) return null
  const v = line.trim().split(/\s+/).slice(1).map(Number)
  // user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (v[3] ?? 0) + (v[4] ?? 0)
  const total = v.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  return { idle, total }
}

export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total
  const di = cur.idle - prev.idle
  if (dt <= 0) return 0
  return Math.max(0, Math.min(100, (100 * (dt - di)) / dt))
}

/** Parse /proc/meminfo into used/total MiB (used = total - available). */
export function parseMeminfo(text: string): { usedMiB: number; totalMiB: number } | null {
  const get = (k: string) => {
    const m = new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const total = get('MemTotal')
  const avail = get('MemAvailable')
  if (total === null || avail === null) return null
  return { usedMiB: Math.round((total - avail) / 1024), totalMiB: Math.round(total / 1024) }
}

export interface HardwareMonitorEvents {
  sample: [HardwareSample]
}

/**
 * Samples GPU (via a long-running nvidia-smi), CPU and RAM once per interval and keeps a
 * rolling history for the UI graphs.
 */
export class HardwareMonitor extends EventEmitter<HardwareMonitorEvents> {
  readonly history: HardwareSample[] = []
  private timer: NodeJS.Timeout | null = null
  private smi: ChildProcess | null = null
  private lastGpu: HardwareSample['gpu'] = null
  private prevCpu: CpuTimes | null = null
  private smiFailed = false

  constructor(
    private readonly liveTps: () => number,
    private readonly intervalMs = 1000,
    private readonly historyMs = 5 * 60 * 1000,
  ) {
    super()
  }

  start(): void {
    if (this.timer) return
    this.startSmi()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.smi?.kill()
    this.smi = null
  }

  private startSmi(): void {
    if (this.smiFailed) return
    try {
      const p = spawn('nvidia-smi', [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits', `-lms`, String(this.intervalMs)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      p.on('error', () => {
        this.smiFailed = true
        this.smi = null
      })
      p.on('exit', () => {
        if (this.smi === p) {
          this.smi = null
          // Restart after a pause unless we were stopped.
          if (this.timer && !this.smiFailed) setTimeout(() => this.timer && this.startSmi(), 5000)
        }
      })
      const rl = createInterface({ input: p.stdout! })
      rl.on('line', (line) => {
        const g = parseNvidiaLine(line)
        if (g) this.lastGpu = g
      })
      this.smi = p
    } catch {
      this.smiFailed = true
    }
  }

  private async tick(): Promise<void> {
    let cpuPct = 0
    let ram = { usedMiB: 0, totalMiB: 0 }
    try {
      const cur = parseProcStat(await readFile('/proc/stat', 'utf8'))
      if (cur && this.prevCpu) cpuPct = cpuPercent(this.prevCpu, cur)
      if (cur) this.prevCpu = cur
      ram = parseMeminfo(await readFile('/proc/meminfo', 'utf8')) ?? ram
    } catch {
      /* non-Linux */
    }
    const sample: HardwareSample = {
      t: Date.now(),
      gpu: this.lastGpu,
      cpuPct: Math.round(cpuPct * 10) / 10,
      ramUsedMiB: ram.usedMiB,
      ramTotalMiB: ram.totalMiB,
      tps: this.liveTps(),
    }
    this.history.push(sample)
    const cutoff = sample.t - this.historyMs
    while (this.history.length && this.history[0].t < cutoff) this.history.shift()
    this.emit('sample', sample)
  }
}
