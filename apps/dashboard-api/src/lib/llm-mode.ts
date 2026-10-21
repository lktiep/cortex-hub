// Whether the hub may call a chat model, and for what. Embeddings are not decided here:
// search, indexing and memory recall need one, local (Ollama) or not, either way.
//
// Three features call a chat model:
//   - memory:    cortex_memory_store extracts facts and merges them with what is stored.
//                Off, a memory is kept as written and near-duplicates are skipped by vector.
//   - recipes:   a finished task or session is turned into a knowledge recipe. Off, nothing is captured.
//   - evolution: the knowledge health check rewrites documents agents keep failing with.
//                Off, it reports nothing to fix.
//
// The hub is off when CORTEX_LLM=off, when onboarding or Settings turned it off, or when no
// chat model is routed (calling one would only fail). MEMORY_LLM=off and RECIPE_CAPTURE=off
// turn a single feature off. CORTEX_LLM=on ignores the stored setting, not a missing model.
import { db } from '../db/client.js'

export type LlmFeature = 'memory' | 'recipes' | 'evolution'
export type LlmMode = 'on' | 'off'

const SETTING_KEY = 'llm.mode'

const FEATURE_ENV: Partial<Record<LlmFeature, string>> = {
  memory: 'MEMORY_LLM',
  recipes: 'RECIPE_CAPTURE',
}

export interface LlmStatus {
  enabled: boolean
  /** Why it is on or off. */
  reason: 'env' | 'setting' | 'no-chat-model' | 'configured'
  /** What Settings or onboarding chose; null when never chosen. */
  setting: LlmMode | null
  /** CORTEX_LLM, when set: it overrides the setting. */
  env: LlmMode | null
  chatModel: string | null
  features: Record<LlmFeature, boolean>
}

function envMode(value: string | undefined): LlmMode | null {
  const v = value?.trim().toLowerCase()
  if (v === 'off' || v === 'false' || v === '0') return 'off'
  if (v === 'on' || v === 'true' || v === '1') return 'on'
  return null
}

/** The first model of the chat routing chain, or null when there is none. */
export function chatModel(): string | null {
  try {
    const row = db.prepare("SELECT chain FROM model_routing WHERE purpose = 'chat'").get() as { chain: string } | undefined
    const chain = row?.chain ? (JSON.parse(row.chain) as Array<{ model?: string }>) : []
    return chain[0]?.model || null
  } catch {
    return null
  }
}

export function llmSetting(): LlmMode | null {
  try {
    const row = db.prepare('SELECT value FROM hub_config WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined
    return row?.value === 'off' ? 'off' : row?.value === 'on' ? 'on' : null
  } catch {
    return null
  }
}

export function setLlmMode(mode: LlmMode): void {
  db.prepare(
    "INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
  ).run(SETTING_KEY, mode)
}

export function llmStatus(env: NodeJS.ProcessEnv = process.env): LlmStatus {
  const setting = llmSetting()
  const forced = envMode(env['CORTEX_LLM'])
  const model = chatModel()

  let enabled: boolean
  let reason: LlmStatus['reason']
  if (forced === 'off') [enabled, reason] = [false, 'env']
  else if (forced !== 'on' && setting === 'off') [enabled, reason] = [false, 'setting']
  else if (!model) [enabled, reason] = [false, 'no-chat-model']
  else [enabled, reason] = [true, forced === 'on' ? 'env' : 'configured']

  const feature = (f: LlmFeature) => {
    const name = FEATURE_ENV[f]
    return enabled && !(name && envMode(env[name]) === 'off')
  }
  return {
    enabled,
    reason,
    setting,
    env: forced,
    chatModel: model,
    features: { memory: feature('memory'), recipes: feature('recipes'), evolution: feature('evolution') },
  }
}

export function llmEnabledFor(feature: LlmFeature, env: NodeJS.ProcessEnv = process.env): boolean {
  return llmStatus(env).features[feature]
}
