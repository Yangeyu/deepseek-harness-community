import { describe, expect, it, vi } from 'vitest'
import { TavilyClient } from '../src/tavily-client.ts'
import { TavilyExtractProvider, type TavilyExtractProviderOptions } from '../src/tavily-extract.ts'

function provider(
  fetch: typeof globalThis.fetch,
  overrides: Partial<TavilyExtractProviderOptions> & {
    resolveApiKey?: () => Promise<string | undefined>
  } = {},
): TavilyExtractProvider {
  const { resolveApiKey = async () => 'tavily-secret', ...providerOverrides } = overrides
  const client = new TavilyClient(() => ({
    apiKeyRef: 'TAVILY_API_KEY',
    resolveApiKey,
    fetch,
  }))
  return new TavilyExtractProvider(client, () => ({
    endpoint: 'https://api.tavily.com/extract',
    extractDepth: 'basic',
    maxOutputChars: 60_000,
    timeoutSeconds: 30,
    ...providerOverrides,
  }))
}

describe('TavilyExtractProvider', () => {
  it('maps extracted markdown to the provider-neutral extraction contract', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      results: [{
        url: 'https://example.com/article',
        raw_content: '# Article\n\nReadable content.',
      }],
      failed_results: [],
      usage: { credits: 1 },
    }), { status: 200 }))

    await expect(provider(fetch).extract({ url: 'https://example.com/article' })).resolves.toEqual({
      url: 'https://example.com/article',
      content: '# Article\n\nReadable content.',
      truncated: false,
    })

    const [, init] = fetch.mock.calls[0] ?? []
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tavily-secret')
    expect(JSON.parse(String(init?.body))).toEqual({
      urls: 'https://example.com/article',
      extract_depth: 'basic',
      include_images: false,
      format: 'markdown',
      timeout: 30,
      include_usage: true,
    })
  })

  it('caps provider content before it reaches the model tool', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      results: [{ url: 'https://example.com', raw_content: '123456' }],
      failed_results: [],
    }), { status: 200 }))
    await expect(provider(fetch, { maxOutputChars: 5 }).extract({ url: 'https://example.com' })).resolves.toMatchObject({
      content: '12345',
      truncated: true,
    })
  })

  it('rejects unsupported or credential-bearing target URLs before network access', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(provider(fetch).extract({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'WEB_INVALID_URL' })
    await expect(provider(fetch).extract({ url: 'https://user:secret@example.com' })).rejects.toMatchObject({ code: 'WEB_INVALID_URL' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('surfaces per-URL extraction failures and quota errors explicitly', async () => {
    const failed = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      results: [],
      failed_results: [{ url: 'https://example.com', error: 'page could not be processed' }],
    }), { status: 200 }))
    await expect(provider(failed).extract({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'WEB_EXTRACT_FAILED',
      message: 'page could not be processed',
    })

    const quota = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      detail: { error: 'usage limit exceeded' },
    }), { status: 432 }))
    await expect(provider(quota).extract({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'WEB_QUOTA_EXCEEDED',
      message: 'usage limit exceeded',
    })
  })

  it('does not send a request when the Tavily credential is absent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(provider(fetch, { resolveApiKey: async () => undefined }).extract({
      url: 'https://example.com',
    })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
