import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { VisionService } from '@vascent/deepseek-harness-vision'
import { describe, expect, it, vi } from 'vitest'
import { harnessImageInput } from '../../../src/infrastructure/harness/image-input.ts'

function llm(image: boolean): Pick<LlmRuntime, 'resolveModelInfo'> {
  return { resolveModelInfo: vi.fn(async () => ({ provider: 'main', id: 'model', inputModalities: image ? ['text', 'image'] : ['text'] })) } as unknown as Pick<LlmRuntime, 'resolveModelInfo'>
}

function proxy(mode: 'auto' | 'proxy' | 'disabled' = 'auto') {
  const route = { strategy: 'proxy' as const, provider: 'proxy', model: 'vision', maxObservationChars: 12000, maxTokens: 2048 }
  return {
    config: { mode, proxyProvider: 'proxy', proxyModel: 'vision', maxObservationChars: 12000, maxTokens: 2048 },
    resolveProxyRoute: vi.fn(async () => route),
    analyze: vi.fn<VisionService['analyze']>(),
  }
}

describe('Host image preparation', () => {
  it('uses native image capability without requiring or enabling the Vision proxy', async () => {
    const native = llm(true)
    const disabled = proxy('disabled')
    for (const vision of [undefined, disabled]) {
      await expect(harnessImageInput(native, vision).resolveImageRoute('main', 'model'))
        .resolves.toEqual({ strategy: 'native', provider: 'main', model: 'model' })
    }
    expect(disabled.resolveProxyRoute).not.toHaveBeenCalled()
  })

  it('uses the configured fallback for text-only models and explicit proxy mode', async () => {
    for (const [main, vision] of [[llm(false), proxy()], [llm(true), proxy('proxy')]] as const) {
      const images = harnessImageInput(main, vision)
      await expect(images.resolveImageRoute('main', 'model')).resolves.toMatchObject({ strategy: 'proxy' })
      expect(vision.resolveProxyRoute).toHaveBeenCalledOnce()
    }
    await expect(harnessImageInput(llm(false)).resolveImageRoute('main', 'model'))
      .resolves.toMatchObject({ strategy: 'disabled', reason: 'proxy-unavailable' })
  })
})
