import z from '@deepseek-ai/schemastery'
import type { ImageRequestPolicy } from '@deepseek-ai/dsh-attachment'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  resolveRetryPolicy,
  RetryPolicySchema,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

export const BAILIAN_PROVIDER_ID = 'bailian'
export const BAILIAN_DISPLAY_NAME = 'Alibaba Cloud Bailian'
export const DEFAULT_BAILIAN_API_KEY_ENV = 'DASHSCOPE_API_KEY'
export const DEFAULT_BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 4 * 1024 * 1024

export const BAILIAN_REASONING_EFFORT_IDS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
const BAILIAN_WIRE_REASONING_EFFORT_IDS = BAILIAN_REASONING_EFFORT_IDS.filter(effort => effort !== 'off')

export type BailianReasoningEffort = typeof BAILIAN_REASONING_EFFORT_IDS[number]
export type BailianInputModality = 'text' | 'image'
export type BailianMaxTokensField = 'max_tokens' | 'max_completion_tokens'

export interface BailianReasoningLevelConfig {
  enableThinking?: boolean
  reasoningEffort?: Exclude<BailianReasoningEffort, 'off'>
  thinkingBudget?: number
}

export interface BailianReasoningConfig {
  defaultEffort: BailianReasoningEffort
  efforts: Partial<Record<BailianReasoningEffort, BailianReasoningLevelConfig>>
}

export interface BailianModelConfig {
  name?: string
  description?: string
  contextWindow: number
  maxOutputTokens: number
  defaultMaxTokens?: number
  maxTokensField: BailianMaxTokensField
  input: BailianInputModality[]
  imagePixelBudget?: number
  imageMaxBytes?: number
  reasoning?: false | BailianReasoningConfig
}

export interface Config {
  apiKeyEnv?: string
  baseURL?: string
  models: Record<string, BailianModelConfig>
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

const ReasoningLevelSchema = z.object({
  enableThinking: z.boolean(),
  reasoningEffort: z.union(BAILIAN_WIRE_REASONING_EFFORT_IDS),
  thinkingBudget: z.number().step(1).min(1),
})

const ReasoningEffortsSchema = z.dict(
  ReasoningLevelSchema,
  z.union(BAILIAN_REASONING_EFFORT_IDS),
) as unknown as z<BailianReasoningConfig['efforts']>

const ReasoningSchema = z.object({
  defaultEffort: z.union(BAILIAN_REASONING_EFFORT_IDS),
  efforts: ReasoningEffortsSchema,
})

const ModelConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxOutputTokens: z.number().step(1).min(1),
  defaultMaxTokens: z.number().step(1).min(1),
  maxTokensField: z.union(['max_tokens', 'max_completion_tokens'] as const),
  input: z.array(z.union(['text', 'image'] as const)),
  imagePixelBudget: z.number().step(1).min(1),
  imageMaxBytes: z.number().step(1).min(1),
  reasoning: z.union([z.const(false), ReasoningSchema]),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_BAILIAN_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BAILIAN_BASE_URL),
  models: z.dict(ModelConfigSchema),
  streamIdleTimeoutMs: z.number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

export interface ResolvedBailianReasoningLevel {
  readonly enableThinking?: boolean
  readonly reasoningEffort?: Exclude<BailianReasoningEffort, 'off'>
  readonly thinkingBudget?: number
}

export interface ResolvedBailianReasoningPolicy {
  readonly defaultEffort: BailianReasoningEffort
  readonly efforts: ReadonlyMap<BailianReasoningEffort, ResolvedBailianReasoningLevel>
}

export interface ResolvedBailianModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly defaultMaxTokens?: number
  readonly maxTokensField: BailianMaxTokensField
  readonly input: readonly BailianInputModality[]
  readonly imageRequestPolicy?: Readonly<ImageRequestPolicy>
  readonly reasoning: false | ResolvedBailianReasoningPolicy
}

export interface ResolvedBailianConfig {
  readonly apiKeyEnv: CredentialRef
  readonly baseURL: string
  readonly models: ReadonlyMap<string, ResolvedBailianModel>
  readonly streamIdleTimeoutMs: number
  readonly retryPolicy: ResolvedRetryPolicy
}

function nonEmpty(value: string | undefined, path: string): string {
  const result = value?.trim()
  if (result === undefined || result.length === 0) throw new Error(`llm-bailian: ${path} must be non-empty`)
  return result
}

function positiveInteger(value: number | undefined, path: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`llm-bailian: ${path} must be a positive safe integer`)
  }
  return value as number
}

function resolveInput(input: readonly BailianInputModality[] | undefined, id: string): readonly BailianInputModality[] {
  if (input === undefined || input.length === 0) {
    throw new Error(`llm-bailian: model "${id}" input must contain at least one modality`)
  }
  const modalities = new Set<BailianInputModality>()
  for (const modality of input) {
    if (modality !== 'text' && modality !== 'image') {
      throw new Error(`llm-bailian: model "${id}" has unsupported input modality "${String(modality)}"`)
    }
    if (modalities.has(modality)) {
      throw new Error(`llm-bailian: model "${id}" repeats input modality "${modality}"`)
    }
    modalities.add(modality)
  }
  return [...modalities]
}

function resolveReasoning(
  configured: false | BailianReasoningConfig | undefined,
  id: string,
): false | ResolvedBailianReasoningPolicy {
  if (configured === undefined || configured === false) return false
  if (!BAILIAN_REASONING_EFFORT_IDS.includes(configured.defaultEffort)) {
    throw new Error(`llm-bailian: model "${id}" has unknown defaultEffort "${String(configured.defaultEffort)}"`)
  }
  const efforts = new Map<BailianReasoningEffort, ResolvedBailianReasoningLevel>()
  for (const [rawEffort, rawLevel] of Object.entries(configured.efforts ?? {})) {
    if (!BAILIAN_REASONING_EFFORT_IDS.includes(rawEffort as BailianReasoningEffort)) {
      throw new Error(`llm-bailian: model "${id}" has unknown reasoning effort "${rawEffort}"`)
    }
    const effort = rawEffort as BailianReasoningEffort
    if (rawLevel === undefined || rawLevel === null || typeof rawLevel !== 'object') {
      throw new Error(`llm-bailian: model "${id}" reasoning effort "${effort}" must be an object`)
    }
    if (effort === 'off' && rawLevel.reasoningEffort !== undefined) {
      throw new Error(`llm-bailian: model "${id}" reasoning effort "off" cannot send reasoning_effort`)
    }
    if (effort === 'off' && rawLevel.thinkingBudget !== undefined) {
      throw new Error(`llm-bailian: model "${id}" reasoning effort "off" cannot send thinking_budget`)
    }
    if (effort === 'off' && rawLevel.enableThinking !== false) {
      throw new Error(`llm-bailian: model "${id}" reasoning effort "off" must set enableThinking to false`)
    }
    if (rawLevel.reasoningEffort !== undefined
      && !BAILIAN_WIRE_REASONING_EFFORT_IDS.includes(rawLevel.reasoningEffort)) {
      throw new Error(`llm-bailian: model "${id}" reasoning effort "${effort}" has an invalid wire value`)
    }
    const thinkingBudget = rawLevel.thinkingBudget === undefined
      ? undefined
      : positiveInteger(rawLevel.thinkingBudget, `model "${id}" reasoning effort "${effort}" thinkingBudget`)
    if (rawLevel.enableThinking === undefined
      && rawLevel.reasoningEffort === undefined
      && thinkingBudget === undefined) {
      throw new Error(`llm-bailian: model "${id}" reasoning effort "${effort}" must set at least one wire field`)
    }
    efforts.set(effort, Object.freeze({
      ...rawLevel.enableThinking === undefined ? {} : { enableThinking: rawLevel.enableThinking },
      ...rawLevel.reasoningEffort === undefined ? {} : { reasoningEffort: rawLevel.reasoningEffort },
      ...thinkingBudget === undefined ? {} : { thinkingBudget },
    }))
  }
  if (efforts.size === 0) throw new Error(`llm-bailian: model "${id}" reasoning.efforts must not be empty`)
  if (!efforts.has(configured.defaultEffort)) {
    throw new Error(`llm-bailian: model "${id}" defaultEffort "${configured.defaultEffort}" is not configured`)
  }
  return Object.freeze({ defaultEffort: configured.defaultEffort, efforts })
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

function resolveModels(models: Readonly<Record<string, BailianModelConfig>> | undefined): ReadonlyMap<string, ResolvedBailianModel> {
  if (models === undefined || Object.keys(models).length === 0) {
    throw new Error('llm-bailian: models must contain at least one model')
  }
  const resolved = new Map<string, ResolvedBailianModel>()
  for (const [rawId, entry] of Object.entries(models)) {
    const id = nonEmpty(rawId, 'model id')
    if (resolved.has(id)) throw new Error(`llm-bailian: duplicate model id "${id}" after trimming`)
    const contextWindow = positiveInteger(entry.contextWindow, `model "${id}" contextWindow`)
    const maxOutputTokens = positiveInteger(entry.maxOutputTokens, `model "${id}" maxOutputTokens`)
    const defaultMaxTokens = entry.defaultMaxTokens === undefined
      ? undefined
      : positiveInteger(entry.defaultMaxTokens, `model "${id}" defaultMaxTokens`)
    if (defaultMaxTokens !== undefined && defaultMaxTokens > maxOutputTokens) {
      throw new Error(`llm-bailian: model "${id}" defaultMaxTokens exceeds maxOutputTokens`)
    }
    if (entry.maxTokensField !== 'max_tokens' && entry.maxTokensField !== 'max_completion_tokens') {
      throw new Error(`llm-bailian: model "${id}" maxTokensField is invalid`)
    }
    const input = Object.freeze(resolveInput(entry.input, id))
    if (!input.includes('image') && (entry.imagePixelBudget !== undefined || entry.imageMaxBytes !== undefined)) {
      throw new Error(`llm-bailian: text-only model "${id}" cannot declare image request limits`)
    }
    const imageRequestPolicy = input.includes('image')
      ? Object.freeze({
          maxPixels: entry.imagePixelBudget === undefined
            ? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
            : positiveInteger(entry.imagePixelBudget, `model "${id}" imagePixelBudget`),
          maxBytes: entry.imageMaxBytes === undefined
            ? DEFAULT_REQUEST_IMAGE_MAX_BYTES
            : positiveInteger(entry.imageMaxBytes, `model "${id}" imageMaxBytes`),
        })
      : undefined
    const description = entry.description?.trim()
    resolved.set(id, Object.freeze({
      id,
      name: entry.name?.trim() || id,
      ...description === undefined || description.length === 0 ? {} : { description },
      contextWindow,
      maxOutputTokens,
      ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
      maxTokensField: entry.maxTokensField,
      input,
      ...imageRequestPolicy === undefined ? {} : { imageRequestPolicy },
      reasoning: resolveReasoning(entry.reasoning, id),
    }))
  }
  return resolved
}

export function resolveBailianConfig(config: Config): ResolvedBailianConfig {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-bailian: streamIdleTimeoutMs must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return Object.freeze({
    apiKeyEnv: credentialRef(config.apiKeyEnv?.trim() || DEFAULT_BAILIAN_API_KEY_ENV),
    baseURL: resolveBailianBaseURL(config.baseURL),
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-bailian: retryPolicy'),
  })
}

export function assertBailianConfig(config: Config): void {
  resolveBailianConfig(config)
}
