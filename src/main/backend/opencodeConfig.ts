/**
 * Builds the OpenCode config (opencode.json) that LocalForge writes into each sandbox at
 * /home/dev/.config/opencode/opencode.json. Schema checked against the OpenAPI `Config`
 * schema served by `opencode serve` 1.19.6 (GET /doc).
 */

import type { ApiModel, ApiProvider } from '../../shared/settings'
import { API_MODEL_PREFIX } from '../../shared/apiModels'

export const PROVIDER_ID = 'localforge'

export interface OpenCodeConfigInput {
  projectId: string
  /** Port of the stats proxy as seen from inside the container (forwarded by pasta -T). */
  proxyPort: number
  /** Model id as served by llama-server (GET /v1/models). */
  modelId: string
  modelName?: string
  contextLimit: number
  outputLimit: number
  vision: boolean
  requireApproval: boolean
  /** 'pixels' | 'norm1000' coordinate convention for the computer-use tools. */
  computerUseCoords?: 'pixels' | 'norm1000'
  /**
   * API models, also reached through the stats proxy (which adds the key). Which model a chat
   * uses is chosen per message (Backend.modelRef), not here: a config change restarts OpenCode,
   * which would interrupt a running agent on every model switch.
   */
  apiProviders?: ApiProvider[]
}

/**
 * Permission rules. OpenCode's defaults (agent/agent.ts, v1.19.6) are allow-all except
 * `doom_loop` (ask), `external_directory` (ask), `.env` reads (ask) and `question` (deny; the plan
 * agent allows it). The user's `permission` is merged AFTER each agent's own rules, so a global
 * `edit` rule would override Plan mode's edit-deny; Plan's edit rule is therefore pinned under
 * `agent.plan.permission` (see buildOpenCodeConfig).
 */
export function permissionConfig(requireApproval: boolean): Record<string, unknown> {
  if (!requireApproval) {
    // The sandbox is isolated: auto-approve everything that would otherwise prompt.
    return { external_directory: 'allow', doom_loop: 'allow', read: 'allow' }
  }
  return {
    read: 'allow',
    external_directory: 'ask',
    doom_loop: 'ask',
    edit: 'ask',
    bash: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    task: 'ask',
    // MCP tools are named <server>_<tool>.
    'computer_*': 'ask',
    'playwright_*': 'ask',
  }
}

/** Plan mode stays read-only regardless of the global rules (only plan files may be written). */
export const PLAN_EDIT_RULE = { '*': 'deny', '.opencode/plans/*.md': 'allow' }

/**
 * OpenCode references models as "<provider>/<model>"; llama-server ids such as
 * "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M" contain '/' and ':', so the config uses a sanitized key
 * and sends the real id via the model's `id` field.
 */
export function modelKeyOf(modelId: string): string {
  const base = modelId.split('/').pop() ?? modelId
  const key = base
    .toLowerCase()
    .replace(/-gguf/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return key || 'local-model'
}

/** OpenCode's key for an API model (a separate namespace from local model keys). */
export function apiModelKeyOf(providerId: string, modelId: string): string {
  return `api-${providerId}-${modelKeyOf(modelId)}`
}

function apiModelEntry(providerId: string, m: ApiModel): Record<string, unknown> {
  return {
    // The proxy recognises this prefix, swaps in the real id and sends it to the provider.
    id: `${API_MODEL_PREFIX}${providerId}/${m.id}`,
    name: m.name,
    tool_call: true,
    reasoning: true,
    attachment: m.vision,
    temperature: true,
    modalities: { input: m.vision ? ['text', 'image'] : ['text'], output: ['text'] },
    limit: { context: m.contextLimit, output: m.outputLimit },
  }
}

export function buildOpenCodeConfig(i: OpenCodeConfigInput): Record<string, unknown> {
  const key = modelKeyOf(i.modelId)
  const apiModels: Record<string, unknown> = {}
  for (const p of i.apiProviders ?? []) {
    for (const m of p.models) apiModels[apiModelKeyOf(p.id, m.id)] = apiModelEntry(p.id, m)
  }
  const model = `${PROVIDER_ID}/${key}`
  return {
    $schema: 'https://opencode.ai/config.json',
    model,
    small_model: model,
    autoupdate: false,
    share: 'disabled',
    provider: {
      [PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'LocalForge (llama.cpp)',
        options: {
          // Every request goes through the LocalForge stats proxy; /p/<id> tags it with the project.
          baseURL: `http://127.0.0.1:${i.proxyPort}/p/${i.projectId}/v1`,
          apiKey: 'localforge',
          // Local generation can be slow (long prompt processing on CPU-offloaded layers).
          timeout: false,
          headerTimeout: 1_800_000,
          chunkTimeout: 1_800_000,
        },
        models: {
          [key]: {
            id: i.modelId,
            name: i.modelName ?? i.modelId,
            tool_call: true,
            reasoning: true,
            attachment: i.vision,
            // false = OpenCode sends no temperature, so llama-server's own sampling flags apply.
            temperature: false,
            modalities: { input: i.vision ? ['text', 'image'] : ['text'], output: ['text'] },
            limit: { context: i.contextLimit, output: i.outputLimit },
          },
          ...apiModels,
        },
      },
    },
    // Tool calling is enabled per model (`tool_call: true` above). The top-level `tools` map is
    // deprecated in OpenCode 1.19 (it is converted into permission rules), so it is not used.
    permission: permissionConfig(i.requireApproval),
    agent: {
      plan: { permission: { edit: PLAN_EDIT_RULE } },
      // LocalForge titles sessions itself; this avoids an extra concurrent LLM call on the GPU.
      title: { disable: true },
    },
    mcp: {
      computer: {
        type: 'local',
        command: ['node', '/opt/localforge/computer-use-mcp/index.js'],
        cwd: '/workspace',
        environment: { DISPLAY: ':1', COMPUTER_USE_COORDS: i.computerUseCoords ?? 'pixels' },
        enabled: true,
        timeout: 60_000,
      },
      playwright: {
        type: 'local',
        // `--browser chromium` = the Playwright-bundled Chromium in the image (the default
        // `chrome` channel would need Google Chrome). Headed on DISPLAY=:1, so the browser is
        // visible in the Agent's Desktop panel. Snapshots go to /workspace/.playwright-mcp.
        command: ['playwright-mcp', '--browser', 'chromium', '--no-sandbox', '--viewport-size', '1200,680'],
        cwd: '/workspace',
        environment: { DISPLAY: ':1', PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright' },
        enabled: true,
        timeout: 60_000,
      },
    },
  }
}
