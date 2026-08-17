import type {
  Model,
  ModelThinkingLevel,
  OpenAICompletionsCompat,
  ThinkingLevelMap,
} from '@earendil-works/pi-ai'

export const BAILIAN_REASONING_EFFORT_IDS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly Exclude<ModelThinkingLevel, 'off'>[]

export const BAILIAN_SELECTABLE_EFFORT_IDS = [
  'off',
  ...BAILIAN_REASONING_EFFORT_IDS,
] as const satisfies readonly ModelThinkingLevel[]

const COMMON_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  maxTokensField: 'max_completion_tokens',
  supportsLongCacheRetention: false,
} as const satisfies OpenAICompletionsCompat

export function bailianCompat(reasoning: boolean): OpenAICompletionsCompat {
  return {
    ...COMMON_COMPAT,
    // Bailian-specific reasoning fields are applied by the provider payload transform.
    supportsReasoningEffort: false,
    ...reasoning ? { thinkingFormat: 'qwen' as const } : {},
  }
}

export interface BailianPiModelInput {
  readonly id: string
  readonly name: string
  readonly baseURL: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly input: readonly ('text' | 'image')[]
  readonly reasoning: false | {
    readonly thinkingLevelMap: ThinkingLevelMap
  }
}

const NO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const

export function createBailianPiModel(input: BailianPiModelInput): Model<'openai-completions'> {
  return {
    id: input.id,
    name: input.name,
    api: 'openai-completions',
    provider: 'bailian',
    baseUrl: input.baseURL,
    reasoning: input.reasoning !== false,
    ...input.reasoning === false ? {} : { thinkingLevelMap: { ...input.reasoning.thinkingLevelMap } },
    input: [...input.input],
    cost: NO_COST,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    compat: bailianCompat(input.reasoning !== false),
  }
}
