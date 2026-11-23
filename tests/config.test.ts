import { describe, expect, it } from 'vitest'
import { buildOpenCodeConfig, modelKeyOf, permissionConfig, PLAN_EDIT_RULE } from '../src/main/backend/opencodeConfig'
import { createArgs, containerName, stateVolumeName } from '../src/main/backend/sandbox'
import { defaultSettings, mergeSettings } from '../src/shared/settings'

const base = {
  projectId: 'demo-abc123',
  proxyPort: 8081,
  modelId: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M',
  modelName: 'Qwen3.8 27B',
  contextLimit: 65536,
  outputLimit: 16384,
  vision: true,
  requireApproval: false,
}

describe('OpenCode config', () => {
  it('points the provider at the stats proxy with the project prefix', () => {
    const cfg = buildOpenCodeConfig(base) as any
    const prov = cfg.provider.localforge
    expect(prov.npm).toBe('@ai-sdk/openai-compatible')
    expect(prov.options.baseURL).toBe('http://127.0.0.1:8081/p/demo-abc123/v1')
    const key = modelKeyOf(base.modelId)
    expect(cfg.model).toBe(`localforge/${key}`)
    const m = prov.models[key]
    expect(m.id).toBe(base.modelId)
    expect(m.tool_call).toBe(true)
    expect(m.limit).toEqual({ context: 65536, output: 16384 })
    expect(m.modalities.input).toContain('image')
    expect(m.temperature).toBe(false) // llama-server's own sampling flags apply
  })

  it('wires the computer-use and Playwright MCP servers onto the agent desktop', () => {
    const cfg = buildOpenCodeConfig(base) as any
    expect(cfg.mcp.computer.command).toEqual(['node', '/opt/localforge/computer-use-mcp/index.js'])
    expect(cfg.mcp.computer.environment.DISPLAY).toBe(':1')
    expect(cfg.mcp.playwright.command.slice(0, 3)).toEqual(['playwright-mcp', '--browser', 'chromium'])
    expect(cfg.mcp.playwright.environment.DISPLAY).toBe(':1')
  })

  it('auto-approves by default but keeps Plan mode read-only', () => {
    const cfg = buildOpenCodeConfig(base) as any
    expect(cfg.permission).toEqual({ external_directory: 'allow', doom_loop: 'allow', read: 'allow' })
    expect(cfg.permission.edit).toBeUndefined() // a global edit rule would override Plan's deny
    expect(cfg.agent.plan.permission.edit).toEqual(PLAN_EDIT_RULE)
    expect(cfg.agent.title.disable).toBe(true)
    expect(cfg.tools).toBeUndefined() // deprecated map, would be turned into permissions
  })

  it('asks before mutating tools when approvals are required', () => {
    const p = permissionConfig(true)
    for (const k of ['edit', 'bash', 'webfetch', 'websearch', 'computer_*', 'playwright_*']) expect(p[k]).toBe('ask')
    expect(p.read).toBe('allow')
  })

  it('makes a safe model key', () => {
    expect(modelKeyOf('unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M')).toBe('qwen3.8-27b-ud-q4_k_m')
    expect(modelKeyOf('')).toBe('local-model')
  })
})

describe('sandbox container arguments', () => {
  const settings = defaultSettings(16)
  const args = createArgs({ projectId: 'demo-abc123', projectName: 'Demo App', projectPath: '/home/u/AIProjects/Demo-App', image: 'localhost/localforge-sandbox:x', settings, password: 'pw' })
  const joined = args.join(' ')

  it('mounts only the project folder (plus the OpenCode state volume)', () => {
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []))
    expect(mounts).toEqual(['/home/u/AIProjects/Demo-App:/workspace', `${stateVolumeName('demo-abc123')}:/home/dev/.local/share/opencode:U`])
    expect(joined).not.toMatch(/docker\.sock|podman\.sock|--privileged|--device|-v \/dev\/|--cap-add/)
  })

  it('isolates networking: only the proxy port reaches host loopback; UIs on 127.0.0.1', () => {
    expect(args).toContain('pasta:-T,8081')
    expect(joined).not.toContain('map-host-loopback')
    expect(args).toContain('127.0.0.1::4096')
    expect(args).toContain('127.0.0.1::6080')
  })

  it('maps the agent user to the host user and applies resource limits', () => {
    expect(args).toContain('--userns=keep-id:uid=1000,gid=1000')
    expect(args[args.indexOf('--cpus') + 1]).toBe(String(settings.sandbox.cpus))
    expect(args[args.indexOf('--memory') + 1]).toBe(`${settings.sandbox.memoryGb}g`)
    expect(args).toContain('--pids-limit')
    expect(args).toContain(`CMAKE_BUILD_PARALLEL_LEVEL=${settings.sandbox.cpus}`)
    expect(args[args.indexOf('--name') + 1]).toBe(containerName('demo-abc123'))
    expect(args[args.length - 1]).toBe('localhost/localforge-sandbox:x')
  })
})

describe('settings merge', () => {
  it('deep-merges partial updates and ignores unknown keys or wrong types', () => {
    const d = defaultSettings(8)
    const m = mergeSettings(d, { llama: { contextLimit: 49152 }, ui: { stats: { thinking: false } }, bogus: 1, proxy: { port: 'x' } })
    expect(m.llama.contextLimit).toBe(49152)
    expect(m.llama.baseUrl).toBe(d.llama.baseUrl)
    expect(m.ui.stats.thinking).toBe(false)
    expect(m.ui.stats.hardware).toBe(true)
    expect(m.proxy.port).toBe(8081)
    expect((m as any).bogus).toBeUndefined()
  })
})
