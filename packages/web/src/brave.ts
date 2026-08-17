import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import { BRAVE_PROVIDER_ID } from './config.ts'
import {
  cleanMessage,
  errorDetail,
  isAbortFailure,
  providerAborted,
  requiredApiKey,
  responsePayload,
  throwIfAborted,
  usableCredentialReference,
  usableEndpoint,
  type FetchImplementation,
} from './http.ts'

const BRAVE_API_VERSION = '2023-01-01'
const DEFAULT_RESULT_COUNT = 8
const MAX_RESULT_COUNT = 20
const MAX_QUERY_CHARS = 400
const MAX_QUERY_WORDS = 50
const MAX_SNIPPET_CHARS = 3_000

export interface BraveSearchProviderOptions {
  endpoint: string
  apiKeyRef: string
  resolveApiKey: () => Promise<string | undefined>
  extraSnippets: boolean
  fetch?: FetchImplementation
}

function resultCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_RESULT_COUNT
  return Math.max(1, Math.min(MAX_RESULT_COUNT, Math.floor(requested)))
}

function searchQuery(query: string): string {
  const value = query.trim()
  if (value === '') throw new WebError('Brave Search requires a non-empty query', 'WEB_INVALID_QUERY')
  if (value.length > MAX_QUERY_CHARS || value.split(/\s+/u).length > MAX_QUERY_WORDS) {
    throw new WebError(
      `Brave Search queries are limited to ${String(MAX_QUERY_CHARS)} characters and ${String(MAX_QUERY_WORDS)} words`,
      'WEB_INVALID_QUERY',
    )
  }
  return value
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function sourceOf(value: unknown): WebSearchSource | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  const url = stringValue(result.url)
  if (url === undefined) return undefined
  const title = stringValue(result.title)
  const snippets = [stringValue(result.description)]
  if (Array.isArray(result.extra_snippets)) {
    for (const snippet of result.extra_snippets) snippets.push(stringValue(snippet))
  }
  const uniqueSnippets = [...new Set(snippets.filter((snippet): snippet is string => snippet !== undefined))]
  const joined = uniqueSnippets.join('\n\n')
  const snippet = joined.length > MAX_SNIPPET_CHARS ? `${joined.slice(0, MAX_SNIPPET_CHARS - 1)}…` : joined
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === '' ? {} : { snippet },
  }
}

function mapResponse(payload: unknown, limit: number): WebSearchResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WebError('Brave Search returned an unprocessable response body', 'WEB_PROVIDER_ERROR')
  }
  const body = payload as Record<string, unknown>
  const web = typeof body.web === 'object' && body.web !== null && !Array.isArray(body.web)
    ? body.web as Record<string, unknown>
    : undefined
  const rawResults = Array.isArray(web?.results) ? web.results : []
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const raw of rawResults) {
    const source = sourceOf(raw)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
    if (sources.length === limit) break
  }
  const query = typeof body.query === 'object' && body.query !== null && !Array.isArray(body.query)
    ? body.query as Record<string, unknown>
    : undefined
  return {
    sources,
    truncated: rawResults.length > limit || query?.more_results_available === true,
  }
}

function errorCode(status: number): string {
  if (status === 401 || status === 403) return 'WEB_UNAUTHORIZED'
  if (status === 429) return 'WEB_RATE_LIMITED'
  return 'WEB_PROVIDER_ERROR'
}

/** Brave Web Search adapter for the provider-neutral `ctx.web` seam. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  constructor(private readonly options: () => BraveSearchProviderOptions) {}

  available(): boolean {
    const options = this.options()
    return usableEndpoint(options.endpoint) && usableCredentialReference(options.apiKeyRef)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.options()
    const query = searchQuery(request.query)
    const count = resultCount(request.maxResults)
    const apiKey = await requiredApiKey('Brave Search', options.apiKeyRef, options.resolveApiKey, signal)
    const endpoint = new URL(options.endpoint)
    endpoint.searchParams.set('q', query)
    endpoint.searchParams.set('count', String(count))
    endpoint.searchParams.set('extra_snippets', String(options.extraSnippets))
    throwIfAborted('Brave Search', signal)
    let response: Response
    try {
      response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'api-version': BRAVE_API_VERSION,
          'x-subscription-token': apiKey,
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortFailure(error)) throw providerAborted('Brave Search', signal, error)
      throw new WebError(`Brave Search request failed: ${cleanMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const payload = await responsePayload(response, 'Brave Search', signal)
    if (!response.ok) {
      const detail = errorDetail(payload) ?? `Brave Search API error (HTTP ${String(response.status)})`
      throw new WebError(detail, errorCode(response.status))
    }
    return mapResponse(payload, count)
  }
}
