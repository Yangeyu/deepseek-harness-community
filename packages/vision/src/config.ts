import z from '@deepseek-ai/schemastery'

const DEFAULT_MAX_OBSERVATION_CHARS = 12_000
const DEFAULT_MAX_TOKENS = 2_048

export const VisionConfigSchema = z.object({
  mode: z.union(['auto', 'proxy', 'disabled'] as const).default('auto').volatile(),
  proxyProvider: z.string().required().volatile(),
  proxyModel: z.string().required().volatile(),
  maxObservationChars: z.number().step(1).min(1).default(DEFAULT_MAX_OBSERVATION_CHARS).volatile(),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
})

export type LiveConfig = ReturnType<typeof VisionConfigSchema>
