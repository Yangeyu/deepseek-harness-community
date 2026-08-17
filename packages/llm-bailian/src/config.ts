import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  resolveRetryPolicy,
  RetryPolicySchema,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import type { ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import {
  BAILIAN_REASONING_EFFORT_IDS,
  BAILIAN_SELECTABLE_EFFORT_IDS,
} from './model.ts'

export const BAILIAN_PROVIDER_ID = 'bailian'
export const BAILIAN_DISPLAY_NAME = 'Alibaba Cloud Bailian'
export const DEFAULT_BAILIAN_API_KEY_ENV = 'DASHSCOPE_API_KEY'
export const DEFAULT_BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const BAILIAN_MODALITIES = ['text', 'image'] as const

export interface BailianReasoningConfig {
  /** Bailian reasoning_effort values; omission means enable_thinking-only. */
  efforts?: Exclude<ModelThinkingLevel, 'off'>[]
  /** Reasoning selection used when the caller does not provide one. */
  defaultEffort: ModelThinkingLevel
  /** Optional Bailian thinking_budget value. */
  thinkingBudget?: number
}

export interface BailianModelConfig {
  /** Model id sent to Bailian. */
  id: string
  /** Optional display label; the model id is used when omitted. */
  name?: string
  /** Total model context capacity. */
  contextWindow: number
  /** Maximum output capacity; this does not create a per-request default. */
  maxTokens: number
  /** Input modalities advertised to Harness. */
  input: ('text' | 'image')[]
  /** Model reasoning capability; omission or false means non-reasoning. */
  reasoning?: false | BailianReasoningConfig
}

export interface Config {
  apiKeyEnv?: string
  baseURL?: string
  models: BailianModelConfig[]
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

const ReasoningPolicySchema = z.object({
  efforts: z.array(z.union(BAILIAN_REASONING_EFFORT_IDS))
    .description('Bailian reasoning_effort values; omit for enable_thinking-only models.'),
  defaultEffort: z.union(BAILIAN_SELECTABLE_EFFORT_IDS)
    .description('Default effort when the caller does not select one.'),
  thinkingBudget: z.number().step(1).min(1)
    .description('Bailian thinking_budget for enabled requests.'),
})

const ModelConfigSchema = z.object({
  id: z.string().description('Model id sent in Bailian requests.'),
  name: z.string().description('Optional display label; defaults to the model id.'),
  contextWindow: z.number().step(1).min(1).description('Total model context capacity.'),
  maxTokens: z.number().step(1).min(1).description('Maximum output capacity, not a request default.'),
  input: z.array(z.union(BAILIAN_MODALITIES)).description('Input modalities advertised to Harness.'),
  reasoning: z.union([z.const(false), ReasoningPolicySchema]),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_BAILIAN_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BAILIAN_BASE_URL),
  models: z.array(ModelConfigSchema),
  streamIdleTimeoutMs: z.number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

export interface ResolvedBailianReasoningPolicy {
  readonly defaultEffort: ModelThinkingLevel
  readonly reasoningEfforts: readonly Exclude<ModelThinkingLevel, 'off'>[]
  readonly thinkingLevelMap: ThinkingLevelMap
  readonly thinkingBudget?: number
}

export interface ResolvedBailianModel {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly input: readonly ('text' | 'image')[]
  readonly reasoning: false | ResolvedBailianReasoningPolicy
}

export interface ResolvedBailianConfig {
  readonly apiKeyEnv: CredentialRef
  readonly baseURL: string
  readonly models: readonly ResolvedBailianModel[]
  readonly streamIdleTimeoutMs: number
  readonly retryPolicy: ResolvedRetryPolicy
}

function positiveInteger(value: number | undefined, path: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`llm-bailian: ${path} must be a positive safe integer`)
  }
  return value as number
}

function configuredInput(
  entry: BailianModelConfig,
  id: string,
): readonly ('text' | 'image')[] {
  if (entry.input === undefined || entry.input.length === 0) {
    throw new Error(`llm-bailian: model "${id}" input must contain at least one modality`)
  }
  const seen = new Set<string>()
  for (const modality of entry.input) {
    if (!BAILIAN_MODALITIES.includes(modality)) {
      throw new Error(`llm-bailian: model "${id}" has unsupported input modality "${String(modality)}"`)
    }
    if (seen.has(modality)) throw new Error(`llm-bailian: model "${id}" repeats input modality "${modality}"`)
    seen.add(modality)
  }
  return [...entry.input]
}

function resolveReasoning(
  configured: false | BailianReasoningConfig | undefined,
  id: string,
): false | ResolvedBailianReasoningPolicy {
  if (configured === undefined || configured === false) return false
  const reasoningEfforts = configured.efforts ?? []
  if (new Set(reasoningEfforts).size !== reasoningEfforts.length) {
    throw new Error(`llm-bailian: model "${id}" reasoning.efforts must not contain duplicates`)
  }
  const unknownEffort = reasoningEfforts.find(effort => !BAILIAN_REASONING_EFFORT_IDS.includes(effort))
  if (unknownEffort !== undefined) {
    throw new Error(`llm-bailian: model "${id}" has unknown reasoning effort "${String(unknownEffort)}"`)
  }

  const defaultEffort = configured.defaultEffort
  if (defaultEffort === undefined) {
    throw new Error(`llm-bailian: model "${id}" reasoning.defaultEffort is required`)
  }
  const selectableEfforts: readonly ModelThinkingLevel[] = [
    'off',
    ...(reasoningEfforts.length === 0 && defaultEffort !== 'off' ? [defaultEffort] : reasoningEfforts),
  ]
  if (!selectableEfforts.some(effort => effort !== 'off')) {
    throw new Error(`llm-bailian: model "${id}" reasoning must offer an enabled effort`)
  }
  if (!selectableEfforts.includes(defaultEffort)) {
    throw new Error(`llm-bailian: model "${id}" defaultEffort "${defaultEffort}" is not supported`)
  }
  const thinkingLevelMap = Object.fromEntries(
    BAILIAN_SELECTABLE_EFFORT_IDS.map(effort => [effort, null]),
  ) as ThinkingLevelMap
  for (const effort of selectableEfforts) {
    if (effort === 'off') delete thinkingLevelMap.off
    else thinkingLevelMap[effort] = effort
  }
  const thinkingBudget = configured.thinkingBudget === undefined
    ? undefined
    : positiveInteger(configured.thinkingBudget, `model "${id}" thinkingBudget`)
  return {
    defaultEffort,
    reasoningEfforts: [...reasoningEfforts],
    thinkingLevelMap,
    ...thinkingBudget === undefined ? {} : { thinkingBudget },
  }
}

export function resolveBailianBaseURL(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BAILIAN_BASE_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('llm-bailian: baseURL must be an absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('llm-bailian: baseURL must use http or https')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('llm-bailian: baseURL must not contain credentials, a query, or a fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/'
  return url.toString().replace(/\/$/u, '')
}

function resolveModels(models: readonly BailianModelConfig[] | undefined): readonly ResolvedBailianModel[] {
  if (models === undefined || models.length === 0) {
    throw new Error('llm-bailian: models must contain at least one model')
  }
  const seen = new Set<string>()
  return models.map((entry, index) => {
    const id = entry.id?.trim()
    if (id === undefined || id.length === 0) throw new Error(`llm-bailian: models[${index}].id is required`)
    if (seen.has(id)) throw new Error(`llm-bailian: duplicate model id "${id}"`)
    seen.add(id)
    const name = entry.name?.trim() || id
    const contextWindow = positiveInteger(entry.contextWindow, `model "${id}" contextWindow`)
    const maxTokens = positiveInteger(entry.maxTokens, `model "${id}" maxTokens`)
    const reasoning = resolveReasoning(entry.reasoning, id)
    return {
      id,
      name,
      contextWindow,
      maxTokens,
      input: configuredInput(entry, id),
      reasoning,
    }
  })
}

export function resolveBailianConfig(config: Config): ResolvedBailianConfig {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-bailian: streamIdleTimeoutMs must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv?.trim() || DEFAULT_BAILIAN_API_KEY_ENV),
    baseURL: resolveBailianBaseURL(config.baseURL),
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-bailian: retryPolicy'),
  }
}

export function assertBailianConfig(config: Config): void {
  resolveBailianConfig(config)
}
