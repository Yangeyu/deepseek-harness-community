import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { VisionService } from '@vascent/deepseek-harness-vision'
import type { ImageInputGateway } from '../../modules/composer/attachments/coordinator.ts'

/** Native image input belongs to the Host; Vision supplies only the optional fallback. */
export function harnessImageInput(
  llm: Pick<LlmRuntime, 'resolveModelInfo'>,
  vision?: Pick<VisionService, 'config' | 'resolveProxyRoute' | 'analyze'>,
): ImageInputGateway {
  return {
    async resolveImageRoute(provider, model, signal) {
      if (vision?.config.mode !== 'proxy') {
        const info = await llm.resolveModelInfo(provider, model, signal).catch(() => undefined)
        signal?.throwIfAborted()
        if (info?.inputModalities?.includes('image')) return { strategy: 'native', provider, model }
      }
      if (vision !== undefined) return vision.resolveProxyRoute(signal)
      return {
        strategy: 'disabled',
        reason: 'proxy-unavailable',
        message: 'The selected model does not declare image input support and no Vision proxy is available. Select an image-capable model or enable Vision.',
      }
    },
    analyze(route, request, signal) {
      if (vision === undefined) throw new Error('No Vision proxy is available.')
      return vision.analyze(route, request, signal)
    },
  }
}
