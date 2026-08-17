import { describe, expect, it, vi } from 'vitest'
import { TavilyClient } from '../src/tavily-client.ts'
import { TavilySearchProvider, type TavilySearchProviderOptions } from '../src/tavily-search.ts'

function provider(
  fetch: typeof globalThis.fetch,
  resolveApiKey: () => Promise<string | undefined> = async () => 'tavily-secret',
  overrides: Partial<TavilySearchProviderOptions> = {},
): TavilySearchProvider {
  const client = new TavilyClient(() => ({
    apiKeyRef: 'TAVILY_API_KEY',
    resolveApiKey,
    fetch,
  }))
  return new TavilySearchProvider(client, () => ({
    endpoint: 'https://api.tavily.com/search',
    searchDepth: 'basic',
    ...overrides,
  }))
}

describe('TavilySearchProvider', () => {
  it('maps Tavily results and sends an explicitly bounded basic search', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      query: 'DeepSeek Harness',
      results: [{
        title: 'DeepSeek Harness',
        url: 'https://example.com/harness',
        content: 'Primary excerpt.',
        score: 0.9,
      }, {
        title: 'Duplicate',
        url: 'https://example.com/harness',
        content: 'Duplicate excerpt.',
      }],
      usage: { credits: 1 },
    }), { status: 200 }))

    await expect(provider(fetch).search({ query: ' DeepSeek Harness ', maxResults: 8 })).resolves.toEqual({
      sources: [{
        title: 'DeepSeek Harness',
        url: 'https://example.com/harness',
        snippet: 'Primary excerpt.',
      }],
      truncated: false,
    })

    const [input, init] = fetch.mock.calls[0] ?? []
    expect(String(input)).toBe('https://api.tavily.com/search')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tavily-secret')
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'DeepSeek Harness',
      search_depth: 'basic',
      max_results: 8,
      topic: 'general',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      auto_parameters: false,
      include_usage: true,
    })
  })

  it('caps the requested result count and marks oversized provider responses as truncated', async () => {
    const results = Array.from({ length: 21 }, (_, index) => ({
      title: `Result ${String(index)}`,
      url: `https://example.com/${String(index)}`,
      content: 'Excerpt',
    }))
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ results }), { status: 200 }))

    const result = await provider(fetch).search({ query: 'query', maxResults: 100 })

    expect(result.sources).toHaveLength(20)
    expect(result.truncated).toBe(true)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ max_results: 20 })
  })

  it('fails before network access when the query or credential is absent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(provider(fetch).search({ query: ' ' })).rejects.toMatchObject({ code: 'WEB_INVALID_QUERY' })
    await expect(provider(fetch, async () => undefined).search({ query: 'current news' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps authentication, rate-limit, and quota responses to stable errors', async () => {
    const cases = [
      { status: 401, code: 'WEB_UNAUTHORIZED' },
      { status: 429, code: 'WEB_RATE_LIMITED' },
      { status: 432, code: 'WEB_QUOTA_EXCEEDED' },
    ] as const
    for (const testCase of cases) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
        detail: { error: `failure-${String(testCase.status)}` },
      }), { status: testCase.status }))
      await expect(provider(fetch).search({ query: 'query' })).rejects.toMatchObject({
        code: testCase.code,
        message: `failure-${String(testCase.status)}`,
      })
    }
  })

  it('honors cancellation while resolving the shared credential', async () => {
    const controller = new AbortController()
    const waiting = new Promise<string | undefined>(() => {})
    const operation = provider(vi.fn<typeof globalThis.fetch>(), () => waiting)
      .search({ query: 'query' }, controller.signal)
    controller.abort(new Error('stop'))
    await expect(operation).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})
