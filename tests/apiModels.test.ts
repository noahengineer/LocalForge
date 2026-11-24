import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StatsProxy } from '../src/main/backend/stats/proxy'
import { parseApiModels } from '../src/main/backend/apiModelList'
import { ApiKeyStore } from '../src/main/backend/apiKeys'
import { Backend } from '../src/main/backend/backend'
import { apiModelKeyOf, buildOpenCodeConfig } from '../src/main/backend/opencodeConfig'
import { activeApiModel, findApiModel, sanitizeProviders } from '../src/shared/apiModels'
import { SettingsStore } from '../src/main/backend/settingsStore'
import type { LlmRequestStats } from '../src/shared/stats'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'lf-api-'))
const VENICE = { id: 'venice', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', models: [{ id: 'e2ee-deepseek-v4-1-flash-1017-abliterated', name: 'DeepSeek', contextLimit: 1_000_000, outputLimit: 32768, vision: false }] }

describe('sanitizeProviders / findApiModel', () => {
  it('keeps good providers and drops malformed ones', () => {
    const out = sanitizeProviders([
      VENICE,
      { id: 'Bad Id', name: 'x', baseUrl: 'https://a.b/v1', models: [] },
      { id: 'nourl', name: 'x', baseUrl: 'not a url', models: [] },
      { id: 'file', name: 'x', baseUrl: 'file:///etc', models: [] },
      { id: 'venice', name: 'dup', baseUrl: 'https://x.y', models: [] },
      { id: 'or', name: 'OR', baseUrl: 'https://openrouter.ai/api/v1/', models: [{ id: 'a/b:free' }, { id: 'has space' }, { id: 'a/b:free' }] },
      'junk',
    ])
    expect(out.map((p) => p.id)).toEqual(['venice', 'or'])
    expect(out[1].baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(out[1].models).toEqual([{ id: 'a/b:free', name: 'a/b:free', contextLimit: 128000, outputLimit: 16384, vision: false }])
  })
  it('finds models whose ids contain slashes', () => {
    const ps = sanitizeProviders([{ id: 'or', name: 'OR', baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'deepseek/deepseek-chat' }] }])
    expect(findApiModel(ps, 'or/deepseek/deepseek-chat')?.model.id).toBe('deepseek/deepseek-chat')
    expect(findApiModel(ps, 'or/nope')).toBeNull()
    expect(activeApiModel({ api: { active: '', providers: ps } })).toBeNull()
  })
  it('settings drop an active model that no longer exists', () => {
    const st = new SettingsStore(path.join(tmp(), 'settings.json'))
    st.update({ api: { providers: [VENICE], active: 'venice/e2ee-deepseek-v4-1-flash-1017-abliterated' } })
    expect(st.get().api.active).toBe('venice/e2ee-deepseek-v4-1-flash-1017-abliterated')
    st.update({ api: { providers: [] } })
    expect(st.get().api.active).toBe('')
  })
})

describe('parseApiModels', () => {
  it('reads Venice model_spec', () => {
    const r = parseApiModels({
      data: [
        { id: 'e2ee-x', type: 'text', model_spec: { name: 'X', availableContextTokens: 1000000, maxCompletionTokens: 131072, capabilities: { supportsFunctionCalling: true, supportsVision: false } } },
        { id: 'img', type: 'image', model_spec: { name: 'Img' } },
        { id: 'nofn', type: 'text', model_spec: { name: 'NoFn', capabilities: { supportsFunctionCalling: false, supportsVision: true } } },
      ],
    })
    expect(r).toEqual([
      { id: 'nofn', name: 'NoFn', contextLimit: null, outputLimit: null, vision: true, tools: false },
      { id: 'e2ee-x', name: 'X', contextLimit: 1000000, outputLimit: 131072, vision: false, tools: true },
    ])
  })
  it('reads OpenRouter and plain OpenAI lists', () => {
    expect(parseApiModels({ data: [{ id: 'a/b', name: 'B', context_length: 64000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'], top_provider: { max_completion_tokens: 8000 } }] })).toEqual([
      { id: 'a/b', name: 'B', contextLimit: 64000, outputLimit: 8000, vision: true, tools: true },
    ])
    expect(parseApiModels({ object: 'list', data: [{ id: 'gpt-x', object: 'model' }] })).toEqual([{ id: 'gpt-x', name: 'gpt-x', contextLimit: null, outputLimit: null, vision: false, tools: null }])
    expect(parseApiModels('nonsense')).toEqual([])
  })
})

describe('ApiKeyStore', () => {
  it('stores owner-only, encrypts when a keyring exists, and removes keys', () => {
    const dir = tmp()
    const rot = { available: () => true, encrypt: (t: string) => Buffer.from([...t].reverse().join('')), decrypt: (b: Buffer) => [...b.toString()].reverse().join('') }
    const a = new ApiKeyStore(rot, path.join(dir, 'k.json'))
    a.set('venice', ' sk-123 ')
    expect(readFileSync(path.join(dir, 'k.json'), 'utf8')).not.toContain('sk-123')
    expect(statSync(path.join(dir, 'k.json')).mode & 0o777).toBe(0o600)
    expect(new ApiKeyStore(rot, path.join(dir, 'k.json')).get('venice')).toBe('sk-123')
    a.set('venice', '')
    expect(a.has('venice')).toBe(false)
    const plain = new ApiKeyStore(null, path.join(dir, 'p.json'))
    plain.set('x', 'k')
    expect(plain.encrypted).toBe(false)
    expect(plain.get('x')).toBe('k')
  })
})

describe('OpenCode config', () => {
  it('lists API models under the proxy provider, keeping the local model as default', () => {
    const cfg = buildOpenCodeConfig({ projectId: 'p1', proxyPort: 8081, modelId: 'unsloth/Q-GGUF:Q4', contextLimit: 131072, outputLimit: 16384, vision: false, requireApproval: false, apiProviders: [VENICE] }) as {
      model: string
      provider: { localforge: { models: Record<string, { id: string; limit: { context: number } }> } }
    }
    const k = apiModelKeyOf('venice', 'e2ee-deepseek-v4-1-flash-1017-abliterated')
    expect(cfg.model).toBe('localforge/q-q4')
    expect(cfg.provider.localforge.models[k].id).toBe('lf-api/venice/e2ee-deepseek-v4-1-flash-1017-abliterated')
    expect(cfg.provider.localforge.models[k].limit.context).toBe(1_000_000)
    // The key is never in the config.
    expect(JSON.stringify(cfg)).not.toMatch(/sk-/)
  })
})

describe('proxy routing to an API', () => {
  const servers: http.Server[] = []
  let proxy: StatsProxy | null = null
  afterEach(async () => {
    await proxy?.stop()
    for (const s of servers.splice(0)) s.close()
  })
  const listen = async (h: http.RequestListener) => {
    const s = http.createServer(h)
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    return (s.address() as AddressInfo).port
  }

  it('sends API models to the provider with the key, and everything else to llama-server', async () => {
    const seen: Array<{ who: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = []
    const handler =
      (who: string) =>
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        let b = ''
        req.on('data', (c) => (b += c))
        req.on('end', () => {
          seen.push({ who, url: req.url!, headers: req.headers, body: b ? JSON.parse(b) : {} })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n`)
          res.end('data: [DONE]\n\n')
        })
      }
    const llamaPort = await listen(handler('llama'))
    const apiPort = await listen(handler('api'))

    const dir = tmp()
    const backend = new Backend({ settingsFile: path.join(dir, 's.json'), dataDir: dir, apiKeysFile: path.join(dir, 'k.json') })
    backend.settings.update({ api: { providers: [{ ...VENICE, id: 'fake', baseUrl: `http://127.0.0.1:${apiPort}/api/v1` }] } })
    backend.apiKeys.set('fake', 'sk-secret')

    proxy = new StatsProxy({ port: 0, upstream: `http://127.0.0.1:${llamaPort}`, route: (b) => backend.apiRoute(b) })
    await proxy.start()
    const ends: LlmRequestStats[] = []
    proxy.on('end', (s) => ends.push(s))
    const post = async (model: string) => {
      const r = await fetch(`http://127.0.0.1:${proxy!.port}/p/proj1/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer localforge', 'x-opencode-session-id': 'ses_1' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      })
      return { status: r.status, text: await r.text() }
    }

    expect((await post('lf-api/fake/e2ee-deepseek-v4-1-flash-1017-abliterated')).status).toBe(200)
    const api = seen.find((s) => s.who === 'api')!
    expect(api.url).toBe('/api/v1/chat/completions')
    expect(api.headers.authorization).toBe('Bearer sk-secret')
    expect(api.headers['x-opencode-session-id']).toBeUndefined()
    expect(api.body.model).toBe('e2ee-deepseek-v4-1-flash-1017-abliterated')
    expect(api.body.stream_options).toEqual({ include_usage: true })
    expect(api.body.timings_per_token).toBeUndefined()
    expect(ends[0].usage?.total_tokens).toBe(9)
    expect(ends[0].sessionId).toBe('ses_1')

    expect((await post('local-model')).status).toBe(200)
    const llama = seen.find((s) => s.who === 'llama')!
    expect(llama.url).toBe('/v1/chat/completions')
    expect(llama.headers.authorization).toBe('Bearer localforge')
    expect(llama.body.timings_per_token).toBe(true)

    // Only configured models, and only with a key.
    const unknown = await post('lf-api/fake/some-other-model')
    expect(unknown.status).toBe(404)
    backend.apiKeys.set('fake', '')
    const nokey = await post('lf-api/fake/e2ee-deepseek-v4-1-flash-1017-abliterated')
    expect(nokey.status).toBe(401)
    expect(nokey.text).toMatch(/no API key/)
    expect(seen.filter((s) => s.who === 'api')).toHaveLength(1)
  })

  it('turns off the Venice system prompt', () => {
    const dir = tmp()
    const backend = new Backend({ settingsFile: path.join(dir, 's.json'), dataDir: dir, apiKeysFile: path.join(dir, 'k.json') })
    backend.settings.update({ api: { providers: [VENICE] } })
    backend.apiKeys.set('venice', 'k')
    const r = backend.apiRoute({ model: 'lf-api/venice/e2ee-deepseek-v4-1-flash-1017-abliterated', messages: [] })
    expect(r && 'body' in r && r.body.venice_parameters).toEqual({ include_venice_system_prompt: false })
    expect(backend.apiRoute({ model: 'unsloth/x' })).toBeNull()
  })
})
