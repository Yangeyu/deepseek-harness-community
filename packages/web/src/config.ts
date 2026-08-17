import z from '@deepseek-ai/schemastery'

export const TAVILY_PROVIDER_ID = 'community-tavily'
export const DEFAULT_TAVILY_API_KEY_ENV = 'TAVILY_API_KEY'
export const DEFAULT_TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'
export const DEFAULT_TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract'
export const DEFAULT_EXTRACT_MAX_OUTPUT_CHARS = 60_000
export const DEFAULT_TAVILY_TIMEOUT_SECONDS = 30

export type TavilySearchDepth = 'basic' | 'advanced' | 'fast' | 'ultra-fast'
export type TavilyExtractDepth = 'basic' | 'advanced'

export interface CommunityWebConfig {
  extractProvider?: string
  extractMaxOutputChars?: number
  tavilyApiKeyEnv?: string
  tavilySearchEndpoint?: string
  tavilyExtractEndpoint?: string
  tavilySearchDepth?: TavilySearchDepth
  tavilyExtractDepth?: TavilyExtractDepth
  tavilyTimeoutSeconds?: number
}

export interface ResolvedCommunityWebConfig {
  extractProvider: string
  extractMaxOutputChars: number
  tavilyApiKeyEnv: string
  tavilySearchEndpoint: string
  tavilyExtractEndpoint: string
  tavilySearchDepth: TavilySearchDepth
  tavilyExtractDepth: TavilyExtractDepth
  tavilyTimeoutSeconds: number
}

export const CommunityWebConfigSchema: z<CommunityWebConfig> = z.object({
  extractProvider: z.string().default(TAVILY_PROVIDER_ID),
  extractMaxOutputChars: z.number().step(1).min(1).default(DEFAULT_EXTRACT_MAX_OUTPUT_CHARS),
  tavilyApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_TAVILY_API_KEY_ENV),
  tavilySearchEndpoint: z.string().default(DEFAULT_TAVILY_SEARCH_ENDPOINT),
  tavilyExtractEndpoint: z.string().default(DEFAULT_TAVILY_EXTRACT_ENDPOINT),
  tavilySearchDepth: z.union(['basic', 'advanced', 'fast', 'ultra-fast'] as const).default('basic'),
  tavilyExtractDepth: z.union(['basic', 'advanced'] as const).default('basic'),
  tavilyTimeoutSeconds: z.number().min(1).max(60).default(DEFAULT_TAVILY_TIMEOUT_SECONDS),
})

export function resolveCommunityWebConfig(config: CommunityWebConfig): ResolvedCommunityWebConfig {
  return {
    extractProvider: config.extractProvider ?? TAVILY_PROVIDER_ID,
    extractMaxOutputChars: config.extractMaxOutputChars ?? DEFAULT_EXTRACT_MAX_OUTPUT_CHARS,
    tavilyApiKeyEnv: config.tavilyApiKeyEnv ?? DEFAULT_TAVILY_API_KEY_ENV,
    tavilySearchEndpoint: config.tavilySearchEndpoint ?? DEFAULT_TAVILY_SEARCH_ENDPOINT,
    tavilyExtractEndpoint: config.tavilyExtractEndpoint ?? DEFAULT_TAVILY_EXTRACT_ENDPOINT,
    tavilySearchDepth: config.tavilySearchDepth ?? 'basic',
    tavilyExtractDepth: config.tavilyExtractDepth ?? 'basic',
    tavilyTimeoutSeconds: config.tavilyTimeoutSeconds ?? DEFAULT_TAVILY_TIMEOUT_SECONDS,
  }
}
