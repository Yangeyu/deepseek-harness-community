import { describe, expect, it } from 'vitest'
import { VisionConfigSchema } from '../src/config.ts'
import type { VisionConfig } from '../src/types.ts'

function resolve(input: unknown): VisionConfig {
  return VisionConfigSchema(input as VisionConfig)
}

describe('Vision config', () => {
  it('requires composition to select the proxy route', () => {
    expect(() => resolve({})).toThrow()
    expect(() => resolve({ proxyProvider: 'provider-only' })).toThrow()
  })

  it('applies only provider-neutral policy defaults', () => {
    expect(resolve({
      proxyProvider: 'custom-provider',
      proxyModel: 'custom-vision-model',
    })).toEqual({
      mode: 'auto',
      proxyProvider: 'custom-provider',
      proxyModel: 'custom-vision-model',
      maxObservationChars: 12_000,
      maxTokens: 2_048,
    })
  })
})
