import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  CommunityWebConfigSchema,
  resolveCommunityWebConfig,
  TAVILY_PROVIDER_ID,
  type CommunityWebConfig,
  type ResolvedCommunityWebConfig,
} from './config.ts'
import type { WebExtractProvider, WebExtractRequest, WebExtractResult } from './extract.ts'
import { TavilyClient } from './tavily-client.ts'
import { TavilyExtractProvider } from './tavily-extract.ts'
import { TavilySearchProvider } from './tavily-search.ts'
import { createWebExtractTool } from './tool.ts'

export {
  CommunityWebConfigSchema as Config,
  DEFAULT_TAVILY_API_KEY_ENV,
  DEFAULT_TAVILY_EXTRACT_ENDPOINT,
  DEFAULT_TAVILY_SEARCH_ENDPOINT,
  DEFAULT_EXTRACT_MAX_OUTPUT_CHARS,
  DEFAULT_TAVILY_TIMEOUT_SECONDS,
  resolveCommunityWebConfig,
  TAVILY_PROVIDER_ID,
  type CommunityWebConfig,
  type ResolvedCommunityWebConfig,
  type TavilyExtractDepth,
  type TavilySearchDepth,
} from './config.ts'
export type { WebExtractProvider, WebExtractRequest, WebExtractResult } from './extract.ts'
export { TavilyClient, type TavilyClientOptions } from './tavily-client.ts'
export { TavilyExtractProvider, type TavilyExtractProviderOptions } from './tavily-extract.ts'
export { TavilySearchProvider, type TavilySearchProviderOptions } from './tavily-search.ts'
export { createWebExtractTool, WEB_EXTRACT_TIMEOUT_MS, WEB_EXTRACT_TOOL_NAME } from './tool.ts'

export const name = 'community-web'
export const COMMUNITY_WEB_SETTINGS_NAMESPACE = settingsNamespace('community-web')

export interface CommunityWebProviderStatus {
  id: string
  endpointHost?: string
  credentialRef: string
  credentialConfigured: boolean
  credentialSource?: string
  credentialWritable: boolean
}

export interface CommunityWebStatus {
  search: CommunityWebProviderStatus
  extract: CommunityWebProviderStatus
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    communityWeb: CommunityWebService
  }
}

function endpointHost(value: string): string | undefined {
  try {
    return new URL(value).host
  } catch {
    return undefined
  }
}

function providerStatus(
  id: string,
  endpoint: string,
  reference: string,
  info: CredentialInfo,
): CommunityWebProviderStatus {
  const host = endpointHost(endpoint)
  return {
    id,
    ...host === undefined ? {} : { endpointHost: host },
    credentialRef: reference,
    credentialConfigured: info.configured,
    ...info.source === undefined ? {} : { credentialSource: info.source },
    credentialWritable: info.writable,
  }
}

/** Registers community providers while leaving selection and model tools with official Harness services. */
export class CommunityWebService extends Service {
  static inject = ['credentials', 'settings', 'systemPrompt', 'tools', 'web']
  static Config = CommunityWebConfigSchema

  private readonly settings: SettingsScope<CommunityWebConfig>
  private readonly tavily: TavilyClient
  private readonly extractProviders = new Map<string, WebExtractProvider>()

  constructor(ctx: Context, config: CommunityWebConfig) {
    super(ctx, 'communityWeb')
    this.settings = ctx.settings.register(COMMUNITY_WEB_SETTINGS_NAMESPACE, CommunityWebConfigSchema, {
      base: config,
      applies: 'live',
    })
    this.tavily = new TavilyClient(() => this.tavilyClientOptions())
    ctx.web.registerSearchProvider(new TavilySearchProvider(this.tavily, () => this.tavilySearchOptions()))
    this.registerExtractProvider(new TavilyExtractProvider(this.tavily, () => this.tavilyExtractOptions()))
    ctx.tools.register(createWebExtractTool({
      extract: (request, signal) => this.extract(request, signal),
    }))
    ctx.systemPrompt.section({
      name: 'tool:web_extract',
      order: 111,
      text: 'Use web_search to discover current sources. Use web_extract when you need the readable content of a specific result URL, and cite that URL as a markdown link in your answer.',
    })
  }

  get config(): ResolvedCommunityWebConfig {
    return resolveCommunityWebConfig(this.settings.get())
  }

  async status(signal?: AbortSignal): Promise<CommunityWebStatus> {
    const config = this.config
    const tavily = await this.ctx.credentials.describe(credentialRef(config.tavilyApiKeyEnv))
    signal?.throwIfAborted()
    return {
      search: providerStatus(TAVILY_PROVIDER_ID, config.tavilySearchEndpoint, config.tavilyApiKeyEnv, tavily),
      extract: providerStatus(TAVILY_PROVIDER_ID, config.tavilyExtractEndpoint, config.tavilyApiKeyEnv, tavily),
    }
  }

  registerExtractProvider(provider: WebExtractProvider): () => void {
    if (this.extractProviders.has(provider.id)) {
      throw new WebError(`an extract provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const providers = this.extractProviders
    const dispose = this.ctx.effect(function* registerCommunityExtractProvider() {
      providers.set(provider.id, provider)
      yield () => { providers.delete(provider.id) }
    }, 'communityWeb.registerExtractProvider()')
    return () => { void dispose() }
  }

  async extract(request: WebExtractRequest, signal?: AbortSignal): Promise<WebExtractResult> {
    const config = this.config
    const provider = this.extractProviders.get(config.extractProvider)
    if (provider === undefined) {
      throw new WebError(`configured extract provider "${config.extractProvider}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured extract provider "${config.extractProvider}" is unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    const result = await provider.extract(request, signal)
    if (result.content.length <= config.extractMaxOutputChars) return result
    return {
      ...result,
      content: result.content.slice(0, config.extractMaxOutputChars),
      truncated: true,
    }
  }

  private tavilyClientOptions() {
    const config = this.config
    return {
      apiKeyRef: config.tavilyApiKeyEnv,
      resolveApiKey: async () => (
        await this.ctx.credentials.resolve(credentialRef(config.tavilyApiKeyEnv))
      )?.value,
    }
  }

  private tavilySearchOptions() {
    const config = this.config
    return {
      endpoint: config.tavilySearchEndpoint,
      searchDepth: config.tavilySearchDepth,
    }
  }

  private tavilyExtractOptions() {
    const config = this.config
    return {
      endpoint: config.tavilyExtractEndpoint,
      extractDepth: config.tavilyExtractDepth,
      maxOutputChars: config.extractMaxOutputChars,
      timeoutSeconds: config.tavilyTimeoutSeconds,
    }
  }
}

export default CommunityWebService
