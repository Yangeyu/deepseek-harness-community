import { Context } from '@deepseek-ai/cordis'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommunityWebService,
  TAVILY_PROVIDER_ID,
  type WebExtractProvider,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('CommunityWebService', () => {
  it('registers one provider per official capability and exposes secret-free status', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registerSearchProvider = vi.fn((_provider: WebSearchProvider) => () => {})
    ctx.provide('web', { registerSearchProvider } as unknown as Context['web'])
    const registerTool = vi.fn((_tool: ToolDefinition) => () => {})
    ctx.provide('tools', { register: registerTool } as unknown as Context['tools'])
    const section = vi.fn(() => () => {})
    ctx.provide('systemPrompt', { section } as unknown as Context['systemPrompt'])
    ctx.provide('settings', {
      register: (_namespace: unknown, _schema: unknown, options: { base: unknown }) => ({
        get: () => options.base,
      }),
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
    expect(registerSearchProvider.mock.calls[0]?.[0]).toMatchObject({ id: TAVILY_PROVIDER_ID })
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({ name: 'web_extract' })
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'tool:web_extract' }))
    const status = await service.status()
    expect(status).toEqual({
      search: {
        id: TAVILY_PROVIDER_ID,
        endpointHost: 'api.tavily.com',
        credentialRef: 'TAVILY_API_KEY',
        credentialConfigured: true,
        credentialSource: 'env',
        credentialWritable: true,
      },
      extract: {
        id: TAVILY_PROVIDER_ID,
        endpointHost: 'api.tavily.com',
        credentialRef: 'TAVILY_API_KEY',
        credentialConfigured: true,
        credentialSource: 'env',
        credentialWritable: true,
      },
    })
    expect(JSON.stringify(status)).not.toContain('must-not-appear')
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
      }),
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
    service.registerExtractProvider(testProvider)

    await expect(service.extract({ url: 'https://example.com' })).resolves.toEqual({
      url: 'https://example.com/',
      content: '12345',
      truncated: true,
    })
    expect(extract).toHaveBeenCalledOnce()
    expect(() => service.registerExtractProvider(testProvider)).toThrow('already registered')

    currentConfig = { extractProvider: 'missing' }
    await expect(service.extract({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    })
  })
})
