import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeepSeekSearchProvider, deepSeekSearchRouteStatus } from '../src/deepseek-search.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('official DeepSeek search adapter', () => {
  it('reuses official provider execution with its registered settings and credential reference', async () => {
    const ctx = new Context()
    ctx.provide('settings', {
      get: () => ({
        apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY',
        baseURL: 'https://search.example/anthropic/v1',
        model: 'deepseek-search-model',
        maxUses: 3,
      }),
    } as unknown as Context['settings'])
    const resolve = vi.fn(async () => ({ value: 'deepseek-secret', source: 'env' }))
    ctx.provide('credentials', { resolve } as unknown as Context['credentials'])
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      content: [{
        type: 'web_search_tool_result',
        content: [{
          type: 'web_search_result',
          url: 'https://example.com/result',
          title: 'Result',
          page_age: 'today',
        }],
      }, {
        type: 'text',
        text: 'Result summary',
        citations: [{
          url: 'https://example.com/result',
          cited_text: 'Cited excerpt.',
        }],
      }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    const provider = createDeepSeekSearchProvider(ctx)
    await expect(provider.search({ query: 'current release' })).resolves.toEqual({
      sources: [{
        url: 'https://example.com/result',
        title: 'Result',
        snippet: 'Cited excerpt.',
        publishedAt: 'today',
      }],
      truncated: false,
    })

    expect(resolve).toHaveBeenCalledOnce()
    const [endpoint, init] = fetch.mock.calls[0] ?? []
    expect(String(endpoint)).toBe('https://search.example/anthropic/v1/messages')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'deepseek-search-model',
      tools: [{ name: 'web_search', max_uses: 3 }],
    })
    expect(deepSeekSearchRouteStatus(ctx)).toEqual({
      apiKeyRef: 'CUSTOM_DEEPSEEK_KEY',
      baseURL: 'https://search.example/anthropic/v1',
      literalCredentialConfigured: false,
    })
  })
})
