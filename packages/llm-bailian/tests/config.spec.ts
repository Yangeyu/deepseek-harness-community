import { describe, expect, it } from 'vitest'
import {
  BailianAdapter,
  BAILIAN_PROVIDER_ID,
  DEFAULT_BAILIAN_BASE_URL,
  resolveBailianBaseURL,
  resolveBailianConfig,
  type BailianModelConfig,
} from '../src/index.ts'
import { httpErrorCode } from '../src/transport.ts'

function deepseekModel(): BailianModelConfig {
  return {
    contextWindow: 1_000_000,
    maxOutputTokens: 393_216,
    maxTokensField: 'max_tokens',
    input: ['text'],
    reasoning: {
      defaultEffort: 'high',
      efforts: {
        off: { enableThinking: false },
        low: { enableThinking: true, reasoningEffort: 'low' },
        high: { enableThinking: true, reasoningEffort: 'high' },
        max: { enableThinking: true, reasoningEffort: 'max' },
      },
    },
  }
}

describe('Bailian config', () => {
  it('normalizes an explicit API root without guessing paths', () => {
    expect(resolveBailianBaseURL(undefined)).toBe(DEFAULT_BAILIAN_BASE_URL)
    expect(resolveBailianBaseURL(`${DEFAULT_BAILIAN_BASE_URL}/`)).toBe(DEFAULT_BAILIAN_BASE_URL)
    expect(resolveBailianBaseURL('https://dashscope.aliyuncs.com')).toBe('https://dashscope.aliyuncs.com')
  })

  it('keeps output capacity separate from an optional request default', async () => {
    const config = resolveBailianConfig({
      models: { 'deepseek-v4-pro-0813': deepseekModel() },
    })
    expect(config.models.get('deepseek-v4-pro-0813')).toMatchObject({
      id: 'deepseek-v4-pro-0813',
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
    })
    const adapter = new BailianAdapter({
      options: () => config,
      resolveApiKey: async () => 'unused',
    })
    const info = await adapter.resolveModel(BAILIAN_PROVIDER_ID, 'deepseek-v4-pro-0813')
    expect(info.defaultMaxTokens).toBeUndefined()
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(info.reasoning?.defaultEffort).toBe('high')
  })

  it('resolves arbitrary deployment ids entirely from configuration', async () => {
    const config = resolveBailianConfig({
      models: {
        'team-deployment-v7': {
          ...deepseekModel(),
          name: 'Team Deployment V7',
          defaultMaxTokens: 8_192,
          reasoning: {
            defaultEffort: 'max',
            efforts: {
              off: { enableThinking: false },
              max: { enableThinking: true, reasoningEffort: 'max' },
            },
          },
        },
      },
    })
    const adapter = new BailianAdapter({ options: () => config, resolveApiKey: async () => 'unused' })
    const info = await adapter.resolveModel(BAILIAN_PROVIDER_ID, 'team-deployment-v7')
    expect(info).toMatchObject({ name: 'Team Deployment V7', defaultMaxTokens: 8_192 })
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'max'])
  })

  it('rejects incomplete or contradictory model policy', () => {
    expect(() => resolveBailianConfig({ models: {} })).toThrow('models must contain at least one model')
    expect(() => resolveBailianConfig({
      models: {
        broken: {
          ...deepseekModel(),
          defaultMaxTokens: 400_000,
        },
      },
    })).toThrow('defaultMaxTokens exceeds maxOutputTokens')
    expect(() => resolveBailianConfig({
      models: {
        broken: {
          ...deepseekModel(),
          reasoning: {
            defaultEffort: 'high',
            efforts: { off: { enableThinking: false } },
          },
        },
      },
    })).toThrow('defaultEffort "high" is not configured')
  })

  it('fails exact resolution for an unconfigured model', async () => {
    const config = resolveBailianConfig({ models: { configured: deepseekModel() } })
    const adapter = new BailianAdapter({ options: () => config, resolveApiKey: async () => 'unused' })
    await expect(adapter.resolveModel(BAILIAN_PROVIDER_ID, 'unknown')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('maps provider HTTP failures to stable Harness codes', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
    expect(httpErrorCode(500)).toBe('SERVER')
    expect(httpErrorCode(400, { message: 'maximum context length exceeded' })).toBe('CONTEXT_WINDOW_EXCEEDED')
  })
})
