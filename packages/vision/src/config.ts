import z from '@deepseek-ai/schemastery'
import type { VisionConfig } from './types.ts'

export const DEFAULT_VISION_PROVIDER = 'dashscope-vision'
export const DEFAULT_VISION_MODEL = 'qwen3.7-plus'
export const DEFAULT_MAX_OBSERVATION_CHARS = 12_000
export const DEFAULT_MAX_TOKENS = 2_048

export const VisionConfigSchema: z<VisionConfig> = z.object({
  mode: z.union(['auto', 'proxy', 'disabled'] as const).default('auto'),
  proxyProvider: z.string().default(DEFAULT_VISION_PROVIDER),
  proxyModel: z.string().default(DEFAULT_VISION_MODEL),
  maxObservationChars: z.number().step(1).min(1).default(DEFAULT_MAX_OBSERVATION_CHARS),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
})
