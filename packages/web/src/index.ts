import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { WebError, type WebSearchProvider } from '@deepseek-ai/dsh-web'
import {
  AUTOMATIC_SEARCH_PROVIDER_ID,
  CommunityWebConfigSchema,
  resolveCommunityWebConfig,
  type CommunityWebConfig,
  type ResolvedCommunityWebConfig,
  type WebSearchSelection,
} from './config.ts'
import { createDeepSeekSearchProvider, deepSeekSearchRouteStatus } from './deepseek-search.ts'
import type { WebExtractProvider, WebExtractRequest, WebExtractResult } from './extract.ts'
import {
  ProviderCatalog,
  type CommunityWebProviderReadiness,
  type CommunityWebProviderRegistration,
  type CommunityWebProviderStatus,
} from './provider-catalog.ts'
import { SelectedSearchProvider } from './search-router.ts'
import { TavilyClient } from './tavily-client.ts'
import { TavilyExtractProvider } from './tavily-extract.ts'
import { TavilySearchProvider } from './tavily-search.ts'
import { createWebExtractTool } from './tool.ts'

export {
  AUTOMATIC_SEARCH_PROVIDER_ID,
  COMMUNITY_SEARCH_PROVIDER_ID,
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
  type WebSearchSelection,
} from './config.ts'
export type { WebExtractProvider, WebExtractRequest, WebExtractResult } from './extract.ts'
export { TavilyClient, type TavilyClientOptions } from './tavily-client.ts'
export { TavilyExtractProvider, type TavilyExtractProviderOptions } from './tavily-extract.ts'
export { TavilySearchProvider, type TavilySearchProviderOptions } from './tavily-search.ts'
export { SelectedSearchProvider } from './search-router.ts'
export {
  type CommunityWebProviderReadiness,
  type CommunityWebProviderRegistration,
  type CommunityWebProviderStatus,
} from './provider-catalog.ts'
export { DEEPSEEK_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-deepseek'
export { createWebExtractTool, WEB_EXTRACT_TIMEOUT_MS, WEB_EXTRACT_TOOL_NAME } from './tool.ts'

export const name = 'community-web'
export const COMMUNITY_WEB_SETTINGS_NAMESPACE = settingsNamespace('community-web')

export interface CommunityWebCapabilityStatus {
  activeProviderId: string
  providers: readonly CommunityWebProviderStatus[]
}

export interface CommunityWebSearchStatus extends CommunityWebCapabilityStatus {
  selection: WebSearchSelection
}

export interface CommunityWebStatus {
  search: CommunityWebSearchStatus
  extract: CommunityWebCapabilityStatus
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

function providerReadiness(
  endpoint: string,
  reference: string,
  info: CredentialInfo,
  configuredRoute: boolean,
  literalCredentialConfigured = false,
): CommunityWebProviderReadiness {
  const host = endpointHost(endpoint)
  const credentialConfigured = literalCredentialConfigured || info.configured
  return {
    ...host === undefined ? {} : { endpointHost: host },
    credentialRef: reference,
    credentialConfigured,
    ...literalCredentialConfigured
      ? { credentialSource: 'provider config' }
      : info.source === undefined ? {} : { credentialSource: info.source },
    credentialWritable: literalCredentialConfigured ? false : info.writable,
    available: configuredRoute && credentialConfigured,
  }
}

/** Registers community providers while leaving selection and model tools with official Harness services. */
export class CommunityWebService extends Service {
  static inject = ['credentials', 'settings', 'systemPrompt', 'tools', 'web']
  static Config = CommunityWebConfigSchema

  private readonly settings: SettingsScope<CommunityWebConfig>
  private readonly tavily: TavilyClient
  private readonly tavilySearch: TavilySearchProvider
  private readonly deepSeekSearch: WebSearchProvider
  private readonly tavilyExtract: TavilyExtractProvider
  private readonly searchProviders: ProviderCatalog<WebSearchProvider>
  private readonly extractProviders: ProviderCatalog<WebExtractProvider>

  constructor(ctx: Context, config: CommunityWebConfig) {
    super(ctx, 'communityWeb')
    this.settings = ctx.settings.register(COMMUNITY_WEB_SETTINGS_NAMESPACE, CommunityWebConfigSchema, {
      base: config,
      applies: 'live',
    })
    this.tavily = new TavilyClient(() => this.tavilyClientOptions())
    this.tavilySearch = new TavilySearchProvider(this.tavily, () => this.tavilySearchOptions())
    this.deepSeekSearch = createDeepSeekSearchProvider(ctx)
    this.tavilyExtract = new TavilyExtractProvider(this.tavily, () => this.tavilyExtractOptions())
    this.searchProviders = new ProviderCatalog(ctx)
    this.extractProviders = new ProviderCatalog(ctx)
    this.registerSearchProvider({
      provider: this.tavilySearch,
      label: 'Tavily',
      description: 'Search through Tavily using the configured search depth and per-operation credential resolution.',
      autoPriority: 200,
      status: signal => this.tavilyReadiness(this.tavilySearch, this.config.tavilySearchEndpoint, signal),
    })
    this.registerSearchProvider({
      provider: this.deepSeekSearch,
      label: 'DeepSeek Official',
      description: 'Use DeepSeek native web search through the official Anthropic-compatible Messages API.',
      autoPriority: 100,
      status: signal => this.deepSeekReadiness(signal),
    })
    this.registerExtractProvider({
      provider: this.tavilyExtract,
      label: 'Tavily',
      description: 'Extract readable Markdown from a public page through Tavily.',
      autoPriority: 100,
      status: signal => this.tavilyReadiness(this.tavilyExtract, this.config.tavilyExtractEndpoint, signal),
    })
    ctx.web.registerSearchProvider(new SelectedSearchProvider(
      this.searchProviders,
      signal => this.selectedSearchProviderId(signal),
    ))
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
    const [searchProviders, extractProviders] = await Promise.all([
      this.searchProviders.statuses(signal),
      this.extractProviders.statuses(signal),
    ])
    signal?.throwIfAborted()
    return {
      search: {
        selection: config.searchProvider,
        activeProviderId: config.searchProvider === AUTOMATIC_SEARCH_PROVIDER_ID
          ? this.automaticProviderId(searchProviders)
          : config.searchProvider,
        providers: searchProviders,
      },
      extract: {
        activeProviderId: config.extractProvider,
        providers: extractProviders,
      },
    }
  }

  async setSearchProvider(searchProvider: WebSearchSelection): Promise<void> {
    if (searchProvider !== AUTOMATIC_SEARCH_PROVIDER_ID && !this.searchProviders.has(searchProvider)) {
      throw new WebError(`web search provider "${searchProvider}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    await this.settings.update({ searchProvider })
  }

  registerSearchProvider(registration: CommunityWebProviderRegistration<WebSearchProvider>): () => void {
    return this.searchProviders.register(registration)
  }

  registerExtractProvider(registration: CommunityWebProviderRegistration<WebExtractProvider>): () => void {
    return this.extractProviders.register(registration)
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

  private async selectedSearchProviderId(signal?: AbortSignal): Promise<string> {
    const config = this.config
    if (config.searchProvider !== AUTOMATIC_SEARCH_PROVIDER_ID) return config.searchProvider
    return this.automaticProviderId(await this.searchProviders.statuses(signal))
  }

  private automaticProviderId(providers: readonly CommunityWebProviderStatus[]): string {
    const provider = providers.find(candidate => candidate.available) ?? providers[0]
    if (provider === undefined) throw new WebError('no web search provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
    return provider.id
  }

  private async tavilyReadiness(
    provider: { available(): boolean },
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<CommunityWebProviderReadiness> {
    const config = this.config
    const credential = await this.ctx.credentials.describe(credentialRef(config.tavilyApiKeyEnv))
    signal?.throwIfAborted()
    return providerReadiness(
      endpoint,
      config.tavilyApiKeyEnv,
      credential,
      provider.available(),
    )
  }

  private async deepSeekReadiness(signal?: AbortSignal): Promise<CommunityWebProviderReadiness> {
    const route = deepSeekSearchRouteStatus(this.ctx)
    const credential = await this.ctx.credentials.describe(credentialRef(route.apiKeyRef))
    signal?.throwIfAborted()
    return providerReadiness(
      route.baseURL,
      route.apiKeyRef,
      credential,
      this.deepSeekSearch.available(),
      route.literalCredentialConfigured,
    )
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
