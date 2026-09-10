import { describe, expect, it, vi } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { harnessProviderAuthentication } from '../../../src/infrastructure/harness/authentication.ts'

const key = credentialKey('llm-pi-ai', 'openai-codex')

describe('Harness model connections', () => {
  it('exposes declared Host flows and delegates authorization with their key and method', async () => {
    const begin = vi.fn(async () => ({ status: 'authorized' as const }))
    const port = harnessProviderAuthentication({
      list: () => [
        { key, label: 'Provider', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false },
        { key: credentialKey('another-provider', 'account'), label: 'Another provider', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false },
      ],
      begin,
    })
    expect(await port.list()).toEqual([{ provider: 'openai-codex', label: 'Provider' }])
    const interaction = { notify: vi.fn(), prompt: vi.fn(async () => '') }
    const signal = new AbortController().signal
    expect(await port.authorize('openai-codex', interaction, signal)).toBe(true)
    expect(begin).toHaveBeenCalledExactlyOnceWith({ key, method: 'oauth', interaction, signal })
  })

  it('offers only registered authorization methods', async () => {
    const port = harnessProviderAuthentication({
      list: () => [{ key, label: 'Provider', methods: [{ id: 'api-key', label: 'API key' }], inFlight: false }],
      begin: vi.fn(),
    })
    expect(await port.list()).toEqual([])
    await expect(port.authorize('openai-codex', { notify: vi.fn(), prompt: vi.fn() }, new AbortController().signal))
      .rejects.toThrow('No authorization flow')
  })
})
