import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyReasoningEffort, dropinPath, effectiveArgs, listCachedModels, modelOf, parallelOf, withServerOptions, writeDropin, quantOf, quoteArg, tokenize, withModel } from '../src/main/backend/models'

const EXEC = `/usr/bin/llama-server -hf unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M --jinja -c 65536 -fa on --cache-type-k q8_0 --cache-type-v q8_0 --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0 --chat-template-kwargs '{"reasoning_effort":"high"}' --no-mmproj-offload --metrics --host 127.0.0.1 --port 8080`

describe('ExecStart handling', () => {
  it('tokenizes the real unit line, keeping the quoted JSON intact', () => {
    const t = tokenize(EXEC)
    expect(t[0]).toBe('/usr/bin/llama-server')
    expect(t[t.indexOf('--chat-template-kwargs') + 1]).toBe('{"reasoning_effort":"high"}')
    expect(modelOf(t)).toEqual({ kind: 'hf', spec: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M' })
  })
  it('round-trips through quoting (what goes into the drop-in parses back the same)', () => {
    const t = tokenize(EXEC)
    expect(tokenize(t.map(quoteArg).join(' '))).toEqual(t)
    expect(quoteArg('{"a":"b"}')).toBe(`'{"a":"b"}'`)
    expect(tokenize(quoteArg(`it's "x"`))).toEqual([`it's "x"`])
  })
  it('replaces only the model, keeping every other flag', () => {
    const t = tokenize(EXEC)
    const n = withModel(t, 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M')
    expect(modelOf(n).spec).toBe('unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M')
    // Everything but the model and the original model's chat-template options is kept.
    const keep = (a: string[]) => a.filter((x) => x !== '-hf' && !x.includes('GGUF') && x !== '--chat-template-kwargs' && !x.includes('reasoning_effort'))
    expect(n).not.toContain('--chat-template-kwargs')
    expect(keep(n)).toEqual(keep(t))
    expect(withModel(t, 'a/b:Q4_K_M', null, false)).toContain('--chat-template-kwargs')
    const f = withModel(t, '/home/u/models/x-Q8_0.gguf', '/home/u/models/mmproj-F16.gguf')
    expect(f.slice(1, 5)).toEqual(['-m', '/home/u/models/x-Q8_0.gguf', '--mmproj', '/home/u/models/mmproj-F16.gguf'])
    expect(f).not.toContain('-hf')
    expect(modelOf(withModel(f, 'a/b:Q4_K_M'))).toEqual({ kind: 'hf', spec: 'a/b:Q4_K_M' })
    expect(withModel(f, 'a/b:Q4_K_M')).not.toContain('--mmproj')
  })
})

describe('quantOf', () => {
  it('reads the quantization from GGUF file names', () => {
    expect(quantOf('Qwen3.8-27B-UD-Q4_K_M.gguf')).toBe('UD-Q4_K_M')
    expect(quantOf('model-IQ3_XXS.gguf')).toBe('IQ3_XXS')
    expect(quantOf('BF16/model-BF16-00001-of-00002.gguf')).toBe('BF16')
    expect(quantOf('weird.gguf')).toBeNull()
  })
})

describe('listCachedModels', () => {
  it('lists Hugging Face cache entries as specs, sums split files and detects vision', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'lf-models-'))
    const snap = path.join(home, '.cache/huggingface/hub/models--unsloth--Foo-GGUF/snapshots/abc')
    mkdirSync(path.join(snap, 'BF16'), { recursive: true })
    writeFileSync(path.join(snap, 'Foo-UD-Q4_K_M.gguf'), Buffer.alloc(100))
    writeFileSync(path.join(snap, 'mmproj-F16.gguf'), Buffer.alloc(10))
    writeFileSync(path.join(snap, 'BF16/Foo-BF16-00001-of-00002.gguf'), Buffer.alloc(50))
    writeFileSync(path.join(snap, 'BF16/Foo-BF16-00002-of-00002.gguf'), Buffer.alloc(70))
    const prevHf = process.env.HF_HOME
    delete process.env.HF_HOME
    const list = listCachedModels(home)
    if (prevHf) process.env.HF_HOME = prevHf
    expect(list.map((m) => [m.spec, m.sizeBytes, m.vision])).toEqual([
      ['unsloth/Foo-GGUF:BF16', 120, true],
      ['unsloth/Foo-GGUF:UD-Q4_K_M', 100, true],
    ])
  })
})

describe('applyReasoningEffort', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }
  it('sends a level only when the loaded model accepts it', () => {
    expect(applyReasoningEffort(body, 'low', ['low', 'medium', 'xhigh']).reasoning_effort).toBe('low')
    expect(applyReasoningEffort(body, 'high', ['low', 'medium', 'xhigh'])).toBe(body)
    expect(applyReasoningEffort(body, 'low', null)).toBe(body)
  })
  it("'none' always works, '' leaves the request alone, non-chat bodies are untouched", () => {
    expect(applyReasoningEffort(body, 'none', null).reasoning_effort).toBe('none')
    expect(applyReasoningEffort(body, '', ['low'])).toBe(body)
    const completion = { prompt: 'x' }
    expect(applyReasoningEffort(completion, 'low', ['low'])).toBe(completion)
  })
  it('overrides an effort the client sent', () => {
    expect(applyReasoningEffort({ ...body, reasoning_effort: 'xhigh' }, 'medium', ['medium', 'xhigh']).reasoning_effort).toBe('medium')
  })
})

describe('one conversation at a time (-np 1)', () => {
  it('replaces any -np/--parallel with -np 1, and leaves the line alone when off', () => {
    const t = tokenize(EXEC)
    expect(parallelOf(withServerOptions(t, { singleSlot: true }))).toBe(1)
    expect(withServerOptions([...t, '--parallel', '4'], { singleSlot: true }).filter((a) => a === '-np' || a === '--parallel')).toEqual(['-np'])
    expect(withServerOptions(t, { singleSlot: false })).toBe(t)
    expect(parallelOf(t)).toBeNull()
  })
  it('writes a drop-in only when something differs from the unit, keeping the original model flags', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lf-unit-'))
    const unit = path.join(dir, 'llama.service')
    writeFileSync(unit, `[Service]\nExecStart=${EXEC}\n`)
    const base = tokenize(EXEC)
    writeDropin(unit, base, { singleSlot: true })
    const eff = effectiveArgs(unit)
    expect(parallelOf(eff)).toBe(1)
    expect(eff).toContain('--chat-template-kwargs') // same model: its template options stay
    expect(modelOf(eff).spec).toBe('unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M')
    writeDropin(unit, base, { singleSlot: false })
    expect(existsSync(dropinPath(unit))).toBe(false)
    writeDropin(unit, withModel(base, 'a/b:Q4_K_M'), { singleSlot: true })
    expect(modelOf(effectiveArgs(unit)).spec).toBe('a/b:Q4_K_M')
    expect(parallelOf(effectiveArgs(unit))).toBe(1)
  })
})
