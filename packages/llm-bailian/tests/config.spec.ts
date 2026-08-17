import { describe, expect, it } from 'vitest'
import {
  BailianAdapter,
  BAILIAN_PROVIDER_ID,
  Config,
  createBailianProfile,
  DEFAULT_BAILIAN_BASE_URL,
  resolveBailianBaseURL,
  resolveBailianConfig,
  type BailianModelConfig,
} from '../src/index.ts'

function deepseekModel(id = 'deepseek-v4-pro-0813'): BailianModelConfig {
  return {
    id,
    contextWindow: 1_000_000,
    maxTokens: 393_216,
    input: ['text'],
    reasoning: {
      defaultEffort: 'high',
      efforts: ['low', 'high', 'max'],
    },
  }
}

function qwenModel(): BailianModelConfig {
  return {
    id: 'qwen3.7-plus',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text', 'image'],
    reasoning: {
      defaultEffort: 'high',
    },
  }
}

describe('Bailian config', () => {
  it('uses an explicit OpenAI-compatible API root without guessing paths', () => {
    expect(resolveBailianBaseURL(undefined)).toBe(DEFAULT_BAILIAN_BASE_URL)
    expect(resolveBailianBaseURL(`${DEFAULT_BAILIAN_BASE_URL}/`)).toBe(DEFAULT_BAILIAN_BASE_URL)
    expect(resolveBailianBaseURL('https://dashscope.aliyuncs.com')).toBe('https://dashscope.aliyuncs.com')
  })

  it('registers configured model capabilities without applying a hidden request cap', async () => {
    const config = resolveBailianConfig({ models: [deepseekModel()] })
    expect(config.models[0]).toMatchObject({
      id: 'deepseek-v4-pro-0813',
      name: 'deepseek-v4-pro-0813',
      contextWindow: 1_000_000,
      maxTokens: 393_216,
      reasoning: {
        defaultEffort: 'high',
        reasoningEfforts: ['low', 'high', 'max'],
      },
    })
    const profile = createBailianProfile(config)
    expect(profile.provider).toBe(BAILIAN_PROVIDER_ID)
    expect(profile.configuredMaxTokens.size).toBe(0)
    const info = await new BailianAdapter({
      profiles: () => new Map([[BAILIAN_PROVIDER_ID, profile]]),
      resolveApiKey: async () => 'unused-for-model-resolution',
    }).resolveModel(BAILIAN_PROVIDER_ID, 'deepseek-v4-pro-0813')
    expect(info.defaultMaxTokens).toBeUndefined()
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(info.reasoning?.defaultEffort).toBe('high')
  })

  it('uses configured capabilities for an arbitrary model id without a code branch', async () => {
    const model = deepseekModel('team-deployment-v7')
    model.name = 'Team Deployment V7'
    model.reasoning = {
      defaultEffort: 'max',
      efforts: ['low', 'max'],
    }
    const config = resolveBailianConfig({ models: [model] })
    expect(config.models[0]).toMatchObject({
      id: 'team-deployment-v7',
      name: 'Team Deployment V7',
      reasoning: {
        defaultEffort: 'max',
        reasoningEfforts: ['low', 'max'],
        thinkingLevelMap: {
          minimal: null,
          low: 'low',
          medium: null,
          high: null,
          xhigh: null,
          max: 'max',
        },
      },
    })
    const info = await new BailianAdapter({
      profiles: () => new Map([[BAILIAN_PROVIDER_ID, createBailianProfile(config)]]),
      resolveApiKey: async () => 'unused-for-model-resolution',
    }).resolveModel(BAILIAN_PROVIDER_ID, 'team-deployment-v7')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'max'])
    expect(info.reasoning?.defaultEffort).toBe('max')
  })

  it('represents enable_thinking-only models without a mode discriminator', () => {
    const model = qwenModel()
    if (model.reasoning !== false && model.reasoning !== undefined) model.reasoning.thinkingBudget = 8_192
    const config = resolveBailianConfig({ models: [model] })
    expect(config.models[0]?.reasoning).toMatchObject({
      defaultEffort: 'high',
      reasoningEfforts: [],
      thinkingBudget: 8_192,
    })
  })

  it('requires an explicit non-empty model catalog', () => {
    expect(() => resolveBailianConfig({ models: [] })).toThrow('models must contain at least one model')
    expect(() => resolveBailianConfig({
      models: [
        deepseekModel(),
        deepseekModel(),
      ],
    })).toThrow('duplicate model id "deepseek-v4-pro-0813"')
  })

  it('requires every model capability consumed by Harness', () => {
    expect(() => resolveBailianConfig({
      models: [{
        id: 'custom-model',
        input: ['text'],
      } as BailianModelConfig],
    })).toThrow('model "custom-model" contextWindow must be a positive safe integer')
    expect(() => resolveBailianConfig({
      models: [{
        id: 'custom-model',
        contextWindow: 10_000,
        maxTokens: 1_000,
        input: [],
      }],
    })).toThrow('model "custom-model" input must contain at least one modality')
  })

  it('publishes only developer-facing model and reasoning fields through the schema', () => {
    const serialized = JSON.stringify(Config.toJSON())
    expect(serialized).toContain('"models"')
    expect(serialized).toContain('"reasoning"')
    expect(serialized).toContain('"defaultEffort"')
    expect(serialized).toContain('"maxTokens"')
    expect(serialized).not.toContain('"preset"')
    expect(serialized).not.toContain('"defaultMaxTokens"')
    expect(serialized).not.toContain('"supportsReasoningEffort"')
    expect(serialized).not.toContain('reasoning-effort')
    expect(serialized).not.toContain('qwen-thinking')

    const parsed = new Config({
      baseURL: DEFAULT_BAILIAN_BASE_URL,
      models: [deepseekModel(), qwenModel()],
    })
    expect(resolveBailianConfig(parsed).models.map(model => model.id)).toEqual([
      'deepseek-v4-pro-0813',
      'qwen3.7-plus',
    ])
  })
})
