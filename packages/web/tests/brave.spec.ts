import { describe, expect, it, vi } from 'vitest'
import { BraveSearchProvider } from '../src/brave.ts'

function provider(
  fetch: typeof globalThis.fetch,
  resolveApiKey: () => Promise<string | undefined> = async () => 'brave-secret',
): BraveSearchProvider {
  return new BraveSearchProvider(() => ({
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
    apiKeyRef: 'BRAVE_API_KEY',
    resolveApiKey,
    extraSnippets: true,
    fetch,
  }))
}

describe('BraveSearchProvider', () => {
  it('maps the provider wire shape and sends bounded authenticated requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      query: { more_results_available: true },
      web: {
        results: [{
          title: 'DeepSeek Harness',
          url: 'https://example.com/harness',
          description: 'Primary excerpt.',
          extra_snippets: ['Secondary excerpt.'],
        }, {
          title: 'Duplicate',
          url: 'https://example.com/harness',
          description: 'Duplicate excerpt.',
        }],
      },
    }), { status: 200 }))

    await expect(provider(fetch).search({ query: ' DeepSeek Harness ', maxResults: 8 })).resolves.toEqual({
      sources: [{
        title: 'DeepSeek Harness',
        url: 'https://example.com/harness',
        snippet: 'Primary excerpt.\n\nSecondary excerpt.',
      }],
      truncated: true,
    })

    const [input, init] = fetch.mock.calls[0] ?? []
    const url = new URL(String(input))
    expect(url.searchParams.get('q')).toBe('DeepSeek Harness')
    expect(url.searchParams.get('count')).toBe('8')
    expect(url.searchParams.get('extra_snippets')).toBe('true')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-subscription-token')).toBe('brave-secret')
    expect(headers.get('api-version')).toBe('2023-01-01')
  })

  it('fails before network access when the credential is missing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(provider(fetch, async () => undefined).search({ query: 'current news' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps authentication and rate-limit responses to stable web error codes', async () => {
    const unauthorized = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      error: { message: 'invalid subscription token' },
    }), { status: 401 }))
    await expect(provider(unauthorized).search({ query: 'query' })).rejects.toMatchObject({
      code: 'WEB_UNAUTHORIZED',
      message: 'invalid subscription token',
    })

    const limited = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 429 }))
    await expect(provider(limited).search({ query: 'query' })).rejects.toMatchObject({ code: 'WEB_RATE_LIMITED' })
  })

  it('honors cancellation while resolving a credential', async () => {
    const controller = new AbortController()
    const waiting = new Promise<string | undefined>(() => {})
    const operation = provider(vi.fn<typeof globalThis.fetch>(), () => waiting)
      .search({ query: 'query' }, controller.signal)
    controller.abort(new Error('stop'))
    await expect(operation).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('rejects queries outside the Brave API contract without changing them', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(provider(fetch).search({ query: 'x'.repeat(401) })).rejects.toMatchObject({
      code: 'WEB_INVALID_QUERY',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
