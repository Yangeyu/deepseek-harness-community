import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { VisionCapability, VisionConfig } from './types.ts'

export function chooseVisionRoute(
  config: VisionConfig,
  main: LlmResolvedModelInfo | undefined,
  proxy: LlmResolvedModelInfo | undefined,
): VisionCapability {
  if (config.mode === 'disabled') {
    return { strategy: 'disabled', reason: 'disabled', message: 'Vision is disabled. Open /config Vision to enable it.' }
  }
  if (config.mode === 'auto' && main?.inputModalities?.includes('image')) {
    return { strategy: 'native', provider: main.provider, model: main.id }
  }
  if (proxy === undefined) {
    return {
      strategy: 'disabled',
      reason: 'proxy-unavailable',
      message: `Vision proxy ${config.proxyProvider}/${config.proxyModel} is unavailable. Open /config Vision to configure it.`,
    }
  }
  if (!proxy.inputModalities?.includes('image')) {
    return {
      strategy: 'disabled',
      reason: 'proxy-does-not-support-images',
      message: `Vision proxy ${config.proxyProvider}/${config.proxyModel} does not declare image input support.`,
    }
  }
  return { strategy: 'proxy', provider: proxy.provider, model: proxy.id }
}
