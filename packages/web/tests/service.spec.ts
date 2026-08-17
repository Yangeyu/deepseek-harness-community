import { Context } from '@deepseek-ai/cordis'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATIC_SEARCH_PROVIDER_ID,
  COMMUNITY_SEARCH_PROVIDER_ID,
  CommunityWebService,
  DEEPSEEK_PROVIDER_ID,
  TAVILY_PROVIDER_ID,
  type WebExtractProvider,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('CommunityWebService', () => {
  it('owns live search selection and exposes every provider without leaking credentials', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registerSearchProvider = vi.fn((_provider: WebSearchProvider) => () => {})
    ctx.provide('web', { registerSearchProvider } as unknown as Context['web'])
    const registerTool = vi.fn((_tool: ToolDefinition) => () => {})
    ctx.provide('tools', { register: registerTool } as unknown as Context['tools'])
    const section = vi.fn(() => () => {})
    ctx.provide('systemPrompt', { section } as unknown as Context['systemPrompt'])
    let currentConfig: Record<string, unknown> = {}
    const update = vi.fn(async (patch: object) => { currentConfig = { ...currentConfig, ...patch } })
    ctx.provide('settings', {
      register: (_namespace: unknown, _schema: unknown, options: { base: unknown }) => {
        currentConfig = options.base as Record<string, unknown>
        return { get: () => currentConfig, update }
      },
      get: () => undefined,
    } as unknown as Context['settings'])
    ctx.provide('credentials', {
      resolve: vi.fn(async () => ({ value: 'must-not-appear', source: 'env' })),
      describe: vi.fn(async () => ({
        configured: true,
        source: 'env',
        writable: true,
      })),
    } as unknown as Context['credentials'])

    const service = new CommunityWebService(ctx, {})
    expect(registerSearchProvider.mock.calls[0]?.[0]).toMatchObject({ id: COMMUNITY_SEARCH_PROVIDER_ID })
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({ name: 'web_extract' })
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'tool:web_extract' }))
    const status = await service.status()
    expect(status).toEqual({
      search: {
        selection: AUTOMATIC_SEARCH_PROVIDER_ID,
        activeProviderId: TAVILY_PROVIDER_ID,
        providers: [{
          id: TAVILY_PROVIDER_ID,
          label: 'Tavily',
          description: 'Search through Tavily using the configured search depth and per-operation credential resolution.',
          endpointHost: 'api.tavily.com',
          credentialRef: 'TAVILY_API_KEY',
          credentialConfigured: true,
          credentialSource: 'env',
          credentialWritable: true,
          available: true,
        }, {
          id: DEEPSEEK_PROVIDER_ID,
          label: 'DeepSeek Official',
          description: 'Use DeepSeek native web search through the official Anthropic-compatible Messages API.',
          endpointHost: 'api.deepseek.com',
          credentialRef: 'DEEPSEEK_API_KEY',
          credentialConfigured: true,
          credentialSource: 'env',
          credentialWritable: true,
          available: true,
        }],
      },
      extract: {
        activeProviderId: TAVILY_PROVIDER_ID,
        providers: [{
          id: TAVILY_PROVIDER_ID,
          label: 'Tavily',
          description: 'Extract readable Markdown from a public page through Tavily.',
          endpointHost: 'api.tavily.com',
          credentialRef: 'TAVILY_API_KEY',
          credentialConfigured: true,
          credentialSource: 'env',
          credentialWritable: true,
          available: true,
        }],
      },
    })
    expect(JSON.stringify(status)).not.toContain('must-not-appear')

    await service.setSearchProvider(DEEPSEEK_PROVIDER_ID)
    expect(update).toHaveBeenCalledWith({ searchProvider: DEEPSEEK_PROVIDER_ID })
    await expect(service.status()).resolves.toMatchObject({
      search: { selection: DEEPSEEK_PROVIDER_ID, activeProviderId: DEEPSEEK_PROVIDER_ID },
    })

    const local: WebSearchProvider = {
      id: 'local-search',
      available: () => true,
      search: async () => ({ sources: [], truncated: false }),
    }
    service.registerSearchProvider({
      provider: local,
      label: 'Local Search',
      description: 'A dynamically registered provider.',
      autoPriority: 300,
      status: async () => ({ available: true }),
    })
    await service.setSearchProvider(AUTOMATIC_SEARCH_PROVIDER_ID)
    const extended = await service.status()
    expect(extended).toMatchObject({
      search: {
        selection: AUTOMATIC_SEARCH_PROVIDER_ID,
        activeProviderId: 'local-search',
      },
    })
    expect(extended.search.providers[0]).toMatchObject({ id: 'local-search', label: 'Local Search' })
  })

  it('uses official search as the automatic route when Tavily is not configured', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('web', { registerSearchProvider: () => () => {} } as unknown as Context['web'])
    ctx.provide('tools', { register: () => () => {} } as unknown as Context['tools'])
    ctx.provide('systemPrompt', { section: () => () => {} } as unknown as Context['systemPrompt'])
    ctx.provide('settings', {
      register: (_namespace: unknown, _schema: unknown, options: { base: unknown }) => ({
        get: () => options.base,
        update: async () => {},
      }),
      get: () => undefined,
    } as unknown as Context['settings'])
    ctx.provide('credentials', {
      resolve: vi.fn(async () => undefined),
      describe: vi.fn(async (reference: string) => ({
        configured: reference === 'DEEPSEEK_API_KEY',
        writable: true,
      })),
    } as unknown as Context['credentials'])

    const status = await new CommunityWebService(ctx, {}).status()

    expect(status.search).toMatchObject({
      selection: AUTOMATIC_SEARCH_PROVIDER_ID,
      activeProviderId: DEEPSEEK_PROVIDER_ID,
    })
    expect(status.search.providers.find(provider => provider.id === TAVILY_PROVIDER_ID)?.available).toBe(false)
    expect(status.search.providers.find(provider => provider.id === DEEPSEEK_PROVIDER_ID)?.available).toBe(true)
  })

  it('selects extraction explicitly, enforces the seam cap, and never falls back', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('web', { registerSearchProvider: () => () => {} } as unknown as Context['web'])
    ctx.provide('tools', { register: () => () => {} } as unknown as Context['tools'])
    ctx.provide('systemPrompt', { section: () => () => {} } as unknown as Context['systemPrompt'])
    let currentConfig: Record<string, unknown> = {}
    ctx.provide('settings', {
      register: (_namespace: unknown, _schema: unknown, options: { base: unknown }) => ({
        get: () => {
          if (Object.keys(currentConfig).length === 0) currentConfig = options.base as Record<string, unknown>
          return currentConfig
        },
        update: async (patch: object) => { currentConfig = { ...currentConfig, ...patch } },
      }),
      get: () => undefined,
    } as unknown as Context['settings'])
    ctx.provide('credentials', {
      resolve: vi.fn(async () => undefined),
      describe: vi.fn(async () => ({ configured: false, writable: true })),
    } as unknown as Context['credentials'])
    const service = new CommunityWebService(ctx, {
      extractProvider: 'test-extract',
      extractMaxOutputChars: 5,
    })
    const extract = vi.fn(async () => ({
      url: 'https://example.com/',
      content: '123456',
      truncated: false,
    }))
    const testProvider: WebExtractProvider = {
      id: 'test-extract',
      available: () => true,
      extract,
    }
    const registration = {
      provider: testProvider,
      label: 'Test Extract',
      description: 'Test provider.',
      autoPriority: 1,
      status: async () => ({ available: true }),
    }
    service.registerExtractProvider(registration)

    await expect(service.extract({ url: 'https://example.com' })).resolves.toEqual({
      url: 'https://example.com/',
      content: '12345',
      truncated: true,
    })
    expect(extract).toHaveBeenCalledOnce()
    expect(() => service.registerExtractProvider(registration)).toThrow('already registered')

    currentConfig = { ...currentConfig, extractProvider: 'missing' }
    await expect(service.extract({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    })
  })
})
