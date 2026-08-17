import {
  WebError,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web'
import { COMMUNITY_SEARCH_PROVIDER_ID } from './config.ts'

export interface SearchProviderRegistry {
  get(id: string): WebSearchProvider | undefined
  someAvailable(): boolean
}

/** One stable provider registered with Harness; the selected backend is resolved for each search. */
export class SelectedSearchProvider implements WebSearchProvider {
  readonly id = COMMUNITY_SEARCH_PROVIDER_ID

  constructor(
    private readonly providers: SearchProviderRegistry,
    private readonly selectedProviderId: (signal?: AbortSignal) => Promise<string>,
  ) {}

  available(): boolean {
    return this.providers.someAvailable()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const providerId = await this.selectedProviderId(signal)
    signal?.throwIfAborted()
    const provider = this.providers.get(providerId)
    if (provider === undefined) {
      throw new WebError(`selected web search provider "${providerId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`selected web search provider "${providerId}" is unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider.search(request, signal)
  }
}
