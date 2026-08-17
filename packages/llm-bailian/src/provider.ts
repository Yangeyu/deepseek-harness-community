import {
  createProvider,
  type Api,
  type ApiKeyAuth,
  type AssistantMessageEventStream,
  type Context as PiContext,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  BAILIAN_DISPLAY_NAME,
  BAILIAN_PROVIDER_ID,
  type ResolvedBailianConfig,
  type ResolvedBailianModel,
} from './config.ts'
import { createBailianPiModel } from './model.ts'

type JsonObject = Record<string, unknown>

function objectPayload(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

export function transformBailianPayload(
  payload: unknown,
  model: ResolvedBailianModel,
  reasoning: ModelThinkingLevel | undefined,
): unknown {
  const source = objectPayload(payload)
  if (source === undefined) return payload
  const next = { ...source }
  if (model.reasoning === false) {
    delete next.enable_thinking
    delete next.reasoning_effort
    delete next.thinking_budget
    return next
  }
  const enabled = reasoning !== undefined && reasoning !== 'off'
  next.enable_thinking = enabled
  if (reasoning !== undefined && reasoning !== 'off' && model.reasoning.reasoningEfforts.includes(reasoning)) {
    next.reasoning_effort = reasoning
  } else {
    delete next.reasoning_effort
  }
  if (enabled && model.reasoning.thinkingBudget !== undefined) {
    next.thinking_budget = model.reasoning.thinkingBudget
  } else {
    delete next.thinking_budget
  }
  return next
}

function withPayloadTransform<T extends StreamOptions | SimpleStreamOptions>(
  options: T | undefined,
  modelConfig: ResolvedBailianModel,
  reasoning: ModelThinkingLevel | undefined,
): T {
  const upstream = options?.onPayload
  return {
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const transformed = transformBailianPayload(payload, modelConfig, reasoning)
      return await upstream?.(transformed, model) ?? transformed
    },
  } as T
}

function modelConfigOf(
  models: ReadonlyMap<string, ResolvedBailianModel>,
  model: Model<Api>,
): ResolvedBailianModel {
  const hit = models.get(model.id)
  if (hit === undefined) throw new Error(`llm-bailian: missing wire policy for model "${model.id}"`)
  return hit
}

function bailianStreams(config: ResolvedBailianConfig): ProviderStreams {
  const base = openAICompletionsApi()
  const models = new Map(config.models.map(model => [model.id, model]))
  return {
    stream(model: Model<Api>, context: PiContext, options?: StreamOptions): AssistantMessageEventStream {
      const modelConfig = modelConfigOf(models, model)
      const reasoning = (options as StreamOptions & { reasoningEffort?: ModelThinkingLevel } | undefined)?.reasoningEffort
      return base.stream(model, context, withPayloadTransform(options, modelConfig, reasoning))
    },
    streamSimple(model: Model<Api>, context: PiContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
      const modelConfig = modelConfigOf(models, model)
      return base.streamSimple(model, context, withPayloadTransform(options, modelConfig, options?.reasoning))
    },
  }
}

function harnessAuth(): ApiKeyAuth {
  return {
    name: BAILIAN_DISPLAY_NAME,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: BAILIAN_DISPLAY_NAME,
    }),
  }
}

export function createBailianProvider(config: ResolvedBailianConfig): Provider<'openai-completions'> {
  const models = config.models.map(model => createBailianPiModel({
    id: model.id,
    name: model.name,
    baseURL: config.baseURL,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    reasoning: model.reasoning === false
      ? false
      : {
          thinkingLevelMap: model.reasoning.thinkingLevelMap,
        },
  }))
  return createProvider({
    id: BAILIAN_PROVIDER_ID,
    name: BAILIAN_DISPLAY_NAME,
    baseUrl: config.baseURL,
    auth: { apiKey: harnessAuth() },
    models,
    api: bailianStreams(config),
  })
}

export interface ResolvedBailianProviderProfile extends ResolvedPiAiProviderProfile {
  readonly defaultReasoningEfforts: ReadonlyMap<string, ReturnType<typeof ReasoningEffortId>>
}

export function createBailianProfile(config: ResolvedBailianConfig): ResolvedBailianProviderProfile {
  return {
    provider: BAILIAN_PROVIDER_ID,
    displayName: BAILIAN_DISPLAY_NAME,
    apiKeyEnv: config.apiKeyEnv,
    api: 'openai-completions',
    baseURL: config.baseURL,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    retryPolicy: config.retryPolicy,
    piProvider: createBailianProvider(config),
    configuredMaxTokens: new Map<string, number>(),
    defaultReasoningEfforts: new Map(config.models.flatMap(model => (
      model.reasoning === false
        ? []
        : [[model.id, ReasoningEffortId(model.reasoning.defaultEffort)] as const]
    ))),
  }
}
