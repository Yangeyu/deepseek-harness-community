import { describe, expect, it } from 'vitest'
import { chooseVisionRoute } from '../src/routing.ts'
import type { VisionConfig } from '../src/types.ts'

const config: VisionConfig = {
  mode: 'auto',
  proxyProvider: 'dashscope-vision',
  proxyModel: 'qwen3.7-plus',
  maxObservationChars: 12_000,
  maxTokens: 2_048,
}

function model(provider: string, id: string, inputModalities: Array<'text' | 'image'>) {
  return {
    provider,
    id,
    name: id,
    inputModalities,
    contextWindow: 100_000,
    maxTokens: 8_192,
  }
}

describe('chooseVisionRoute', () => {
  it('uses the active model when auto mode declares image input', () => {
    expect(chooseVisionRoute(
      config,
      model('native', 'multimodal', ['text', 'image']),
      model('proxy', 'vision', ['text', 'image']),
    )).toEqual({ strategy: 'native', provider: 'native', model: 'multimodal' })
  })

  it('falls back to the configured proxy for a text-only active model', () => {
    expect(chooseVisionRoute(
      config,
      model('deepseek', 'chat', ['text']),
      model('dashscope-vision', 'qwen3.7-plus', ['text', 'image']),
    )).toEqual({ strategy: 'proxy', provider: 'dashscope-vision', model: 'qwen3.7-plus' })
  })

  it('always uses the proxy in proxy mode', () => {
    expect(chooseVisionRoute(
      { ...config, mode: 'proxy' },
      model('native', 'multimodal', ['text', 'image']),
      model('proxy', 'vision', ['text', 'image']),
    )).toEqual({ strategy: 'proxy', provider: 'proxy', model: 'vision' })
  })

  it('returns an actionable disabled state when the proxy is unavailable', () => {
    expect(chooseVisionRoute(config, model('deepseek', 'chat', ['text']), undefined)).toMatchObject({
      strategy: 'disabled',
      reason: 'proxy-unavailable',
    })
  })

  it('honors disabled mode without resolving another route', () => {
    expect(chooseVisionRoute({ ...config, mode: 'disabled' }, undefined, undefined)).toMatchObject({
      strategy: 'disabled',
      reason: 'disabled',
    })
  })
})
