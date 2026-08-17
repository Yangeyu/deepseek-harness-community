import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import { TAVILY_PROVIDER_ID, type TavilySearchDepth } from './config.ts'
import { TavilyClient } from './tavily-client.ts'

const DEFAULT_RESULT_COUNT = 5
const MAX_RESULT_COUNT = 20
const MAX_SNIPPET_CHARS = 3_000

export interface TavilySearchProviderOptions {
  endpoint: string
  searchDepth: TavilySearchDepth
}

function resultCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_RESULT_COUNT
  return Math.max(1, Math.min(MAX_RESULT_COUNT, Math.floor(requested)))
}

function searchQuery(query: string): string {
  const value = query.trim()
  if (value === '') throw new WebError('Tavily Search requires a non-empty query', 'WEB_INVALID_QUERY')
  return value
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function sourceOf(value: unknown): WebSearchSource | undefined {
  const result = resultRecord(value)
  if (result === undefined) return undefined
  const url = stringValue(result.url)
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '') {
      return undefined
    }
  } catch {
    return undefined
  }
  const title = stringValue(result.title)
  const rawSnippet = stringValue(result.content)
  const snippet = rawSnippet !== undefined && rawSnippet.length > MAX_SNIPPET_CHARS
    ? `${rawSnippet.slice(0, MAX_SNIPPET_CHARS - 1)}…`
    : rawSnippet
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
  }
}

function mapResponse(payload: unknown, limit: number): WebSearchResult {
  const body = resultRecord(payload)
  if (body === undefined) throw new WebError('Tavily Search returned an unprocessable response body', 'WEB_PROVIDER_ERROR')
  const rawResults = Array.isArray(body.results) ? body.results : []
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const raw of rawResults) {
    const source = sourceOf(raw)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
    if (sources.length === limit) break
  }
  return {
    sources,
    truncated: rawResults.length > limit,
  }
}

/** Tavily Search adapter for the official provider-neutral `ctx.web` seam. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(
    private readonly client: TavilyClient,
    private readonly options: () => TavilySearchProviderOptions,
  ) {}

  available(): boolean {
    const options = this.options()
    return this.client.available(options.endpoint)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.options()
    const count = resultCount(request.maxResults)
    const payload = await this.client.post('Tavily Search', options.endpoint, {
      query: searchQuery(request.query),
      search_depth: options.searchDepth,
      max_results: count,
      topic: 'general',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      auto_parameters: false,
      include_usage: true,
    }, signal)
    return mapResponse(payload, count)
  }
}
