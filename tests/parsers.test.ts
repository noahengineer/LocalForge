import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cpuPercent, parseMeminfo, parseNvidiaLine, parseProcStat } from '../src/main/backend/hardware'
import { parseSize, parseStats } from '../src/main/backend/podman'
import { parseMetrics } from '../src/main/backend/llama'
import { contextHash, parseStepLine } from '../src/main/backend/image'
import { parseChanges } from '../src/main/backend/checkpoints'

describe('hardware parsers', () => {
  it('parses an nvidia-smi CSV line', () => {
    expect(parseNvidiaLine('NVIDIA GeForce RTX 4060 Ti, 14887, 16380, 97, 61, 142.31, 165.00')).toEqual({
      name: 'NVIDIA GeForce RTX 4060 Ti',
      vramUsedMiB: 14887,
      vramTotalMiB: 16380,
      utilPct: 97,
      tempC: 61,
      powerW: 142.31,
      powerLimitW: 165,
    })
    expect(parseNvidiaLine('garbage')).toBeNull()
    expect(parseNvidiaLine('GPU, [N/A], 16380, 0, 40, [N/A], [N/A]')).toBeNull()
  })
  it('computes CPU% from /proc/stat deltas', () => {
    const a = parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3')!
    const b = parseProcStat('cpu  150 0 150 900 0 0 0 0 0 0\n')!
    expect(cpuPercent(a, b)).toBeCloseTo(50)
  })
  it('computes used RAM from MemAvailable', () => {
    expect(parseMeminfo('MemTotal:       65011712 kB\nMemFree: 1 kB\nMemAvailable:   48758784 kB\n')).toEqual({ usedMiB: 15872, totalMiB: 63488 })
  })
})

describe('podman parsers', () => {
  it('parses sizes in SI and IEC units', () => {
    expect(parseSize('8.59GB')).toBeCloseTo(8192.0, -1)
    expect(parseSize('512MiB')).toBe(512)
    expect(parseSize('1kB')).toBeCloseTo(1000 / 1048576)
    expect(parseSize('?')).toBe(0)
  })
  it('parses podman stats JSON', () => {
    const s = parseStats('[{"name":"localforge-x","cpu_percent":"3.90%","mem_usage":"641.4MB / 8.59GB"}]')
    expect(s[0].name).toBe('localforge-x')
    expect(s[0].cpuPct).toBeCloseTo(3.9)
    expect(s[0].memUsedMiB).toBeCloseTo(611.7, 0)
    expect(parseStats('not json')).toEqual([])
  })
})

describe('llama-server /metrics', () => {
  it('parses Prometheus text', () => {
    const m = parseMetrics('# HELP x\n# TYPE x counter\nllamacpp:prompt_tokens_total 1234\nllamacpp:predicted_tokens_seconds 7.35\nllamacpp:requests_processing{slot="0"} 1\n')
    expect(m['llamacpp:prompt_tokens_total']).toBe(1234)
    expect(m['llamacpp:predicted_tokens_seconds']).toBe(7.35)
    expect(m['llamacpp:requests_processing']).toBe(1)
  })
})

describe('image build helpers', () => {
  it('parses podman build step lines', () => {
    expect(parseStepLine('STEP 12/28: RUN npm install -g x')).toEqual({ step: 12, total: 28, text: 'RUN npm install -g x' })
    expect(parseStepLine('--> abc')).toBeNull()
  })
  it('hashes the build context deterministically and ignores node_modules', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'lf-ctx-'))
    writeFileSync(path.join(d, 'Containerfile'), 'FROM x')
    const h1 = contextHash(d)
    mkdirSync(path.join(d, 'node_modules'))
    writeFileSync(path.join(d, 'node_modules', 'junk'), 'zzz')
    expect(contextHash(d)).toBe(h1)
    writeFileSync(path.join(d, 'Containerfile'), 'FROM y')
    expect(contextHash(d)).not.toBe(h1)
  })
})

describe('changes parser', () => {
  it('splits sections', () => {
    const c = parseChanges('@@BASE abc\x1fCheckpoint: x\n@@NUMSTAT\n3\t1\tsrc/a.ts\n-\t-\timg.png\n@@STATUS\nM\tsrc/a.ts\nA\timg.png\n@@DIFF\ndiff --git a/src/a.ts b/src/a.ts\n+x\n')
    expect(c.baseCommit).toBe('abc')
    expect(c.files).toEqual([
      { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 },
      { path: 'img.png', status: 'A', additions: 0, deletions: 0 },
    ])
    expect(c.diff).toContain('+x')
  })
})
