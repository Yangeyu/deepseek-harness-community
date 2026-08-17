import z from '@deepseek-ai/schemastery'

export const BRAVE_PROVIDER_ID = 'community-brave'
export const TAVILY_PROVIDER_ID = 'community-tavily'
export const DEFAULT_BRAVE_API_KEY_ENV = 'BRAVE_API_KEY'
export const DEFAULT_TAVILY_API_KEY_ENV = 'TAVILY_API_KEY'
export const DEFAULT_BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
export const DEFAULT_TAVILY_ENDPOINT = 'https://api.tavily.com/extract'
export const DEFAULT_EXTRACT_MAX_OUTPUT_CHARS = 60_000
export const DEFAULT_TAVILY_TIMEOUT_SECONDS = 30

export type TavilyExtractDepth = 'basic' | 'advanced'

export interface CommunityWebConfig {
  braveApiKeyEnv?: string
  braveEndpoint?: string
  braveExtraSnippets?: boolean
  extractProvider?: string
  extractMaxOutputChars?: number
  tavilyApiKeyEnv?: string
  tavilyEndpoint?: string
  tavilyExtractDepth?: TavilyExtractDepth
  tavilyTimeoutSeconds?: number
}

export interface ResolvedCommunityWebConfig {
  braveApiKeyEnv: string
  braveEndpoint: string
  braveExtraSnippets: boolean
  extractProvider: string
  extractMaxOutputChars: number
  tavilyApiKeyEnv: string
  tavilyEndpoint: string
  tavilyExtractDepth: TavilyExtractDepth
  tavilyTimeoutSeconds: number
}

export const CommunityWebConfigSchema: z<CommunityWebConfig> = z.object({
  braveApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_BRAVE_API_KEY_ENV),
  braveEndpoint: z.string().default(DEFAULT_BRAVE_ENDPOINT),
  braveExtraSnippets: z.boolean().default(true),
  extractProvider: z.string().default(TAVILY_PROVIDER_ID),
  extractMaxOutputChars: z.number().step(1).min(1).default(DEFAULT_EXTRACT_MAX_OUTPUT_CHARS),
  tavilyApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_TAVILY_API_KEY_ENV),
  tavilyEndpoint: z.string().default(DEFAULT_TAVILY_ENDPOINT),
  tavilyExtractDepth: z.union(['basic', 'advanced'] as const).default('basic'),
  tavilyTimeoutSeconds: z.number().min(1).max(60).default(DEFAULT_TAVILY_TIMEOUT_SECONDS),
})

export function resolveCommunityWebConfig(config: CommunityWebConfig): ResolvedCommunityWebConfig {
  return {
    braveApiKeyEnv: config.braveApiKeyEnv ?? DEFAULT_BRAVE_API_KEY_ENV,
    braveEndpoint: config.braveEndpoint ?? DEFAULT_BRAVE_ENDPOINT,
    braveExtraSnippets: config.braveExtraSnippets ?? true,
    extractProvider: config.extractProvider ?? TAVILY_PROVIDER_ID,
    extractMaxOutputChars: config.extractMaxOutputChars ?? DEFAULT_EXTRACT_MAX_OUTPUT_CHARS,
    tavilyApiKeyEnv: config.tavilyApiKeyEnv ?? DEFAULT_TAVILY_API_KEY_ENV,
    tavilyEndpoint: config.tavilyEndpoint ?? DEFAULT_TAVILY_ENDPOINT,
    tavilyExtractDepth: config.tavilyExtractDepth ?? 'basic',
    tavilyTimeoutSeconds: config.tavilyTimeoutSeconds ?? DEFAULT_TAVILY_TIMEOUT_SECONDS,
  }
}
