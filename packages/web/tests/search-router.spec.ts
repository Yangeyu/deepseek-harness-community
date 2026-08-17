import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import { COMMUNITY_SEARCH_PROVIDER_ID, SelectedSearchProvider } from '../src/index.ts'

function provider(id: string) {
  return {
    id,
    available: () => true,
    search: vi.fn(async () => ({ sources: [{ url: `https://${id}.example` }], truncated: false })),
  } satisfies WebSearchProvider
}

function registry(providers: readonly WebSearchProvider[]) {
  const byId = new Map(providers.map(provider => [provider.id, provider]))
  return {
    get: (id: string) => byId.get(id),
    someAvailable: () => [...byId.values()].some(provider => provider.available()),
  }
}

describe('SelectedSearchProvider', () => {
  it('delegates only to the selected provider for each operation', async () => {
    const tavily = provider('tavily')
    const official = provider('official')
    let selected = 'official'
    const router = new SelectedSearchProvider(
      registry([tavily, official]),
      async () => selected,
    )

    expect(router.id).toBe(COMMUNITY_SEARCH_PROVIDER_ID)
    await expect(router.search({ query: 'one' })).resolves.toMatchObject({
      sources: [{ url: 'https://official.example' }],
    })
    selected = 'tavily'
    await expect(router.search({ query: 'two' })).resolves.toMatchObject({
      sources: [{ url: 'https://tavily.example' }],
    })
    expect(official.search).toHaveBeenCalledTimes(1)
    expect(tavily.search).toHaveBeenCalledTimes(1)
  })

  it('fails explicitly for an unavailable selection instead of trying another provider', async () => {
    const unavailable = { ...provider('unavailable'), available: () => false }
    const fallback = provider('fallback')
    const router = new SelectedSearchProvider(
      registry([unavailable, fallback]),
      async () => unavailable.id,
    )

    await expect(router.search({ query: 'query' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    })
    expect(unavailable.search).not.toHaveBeenCalled()
    expect(fallback.search).not.toHaveBeenCalled()
  })
})
