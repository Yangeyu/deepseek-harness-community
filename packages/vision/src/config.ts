import z from '@deepseek-ai/schemastery'
import type { VisionConfig } from './types.ts'

export const DEFAULT_MAX_OBSERVATION_CHARS = 12_000
export const DEFAULT_MAX_TOKENS = 2_048

export const VisionConfigSchema: z<VisionConfig> = z.object({
  mode: z.union(['auto', 'proxy', 'disabled'] as const).default('auto'),
  proxyProvider: z.string().required(),
  proxyModel: z.string().required(),
  maxObservationChars: z.number().step(1).min(1).default(DEFAULT_MAX_OBSERVATION_CHARS),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
})
