import { TuiMainScreen, type Component, type Terminal } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { AuthenticationProcess } from '../../../src/modules/authentication/process.ts'
import type { ProviderAuthenticationPort } from '../../../src/modules/authentication/contracts.ts'
import { AuthorizationView } from '../../../src/modules/authentication/view.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'

function setup(port: ProviderAuthenticationPort) {
  const scope = new LifecycleScope('authentication-test')
  let current: Component | undefined
  const surfaces = {
    get active() { return current !== undefined },
    open: ({ component }: { component: Component }) => {
      current = component
      return { close: () => { current = undefined; return true } }
    },
  }
  const openUrl = vi.fn(async () => {})
  const process = new AuthenticationProcess({ port, surfaces, scope, openUrl,
    tui: new TuiMainScreen({ columns: 100, rows: 24 } as Terminal), theme: createTheme(false),
    invalidate: vi.fn(),
  })
  return { process, scope, openUrl, get view() { return current as AuthorizationView } }
}

describe('provider authorization within Harness', () => {
  it('preserves browser instructions while a callback withdraws the manual prompt', async () => {
    const test = setup({
      list: async () => [{ provider: 'openai-codex', label: 'ChatGPT' }],
      authorize: async (_, interaction) => {
        interaction.notify({ message: 'Open the browser', url: 'https://auth.openai.com/authorize' })
        const prompt = new AbortController()
        const answer = interaction.prompt({ kind: 'text', message: 'Paste callback URL', signal: prompt.signal })
        expect(test.view.render(100).join('\n')).toContain('https://auth.openai.com/authorize')
        expect(test.view.render(100).join('\n')).toContain('Paste callback URL')
        prompt.abort(new Error('Browser callback won'))
        await expect(answer).rejects.toThrow('Browser callback won')
        expect(test.view.prompt).toBeUndefined()
        return true
      },
    })
    expect(await test.process.connect('openai-codex')).toBe(true)
    expect(test.openUrl).toHaveBeenCalledWith('https://auth.openai.com/authorize')
    expect(test.view).toBeUndefined()
    await test.scope.dispose()
  })

  it('cancels the entire attempt through Esc without reporting authorization', async () => {
    const test = setup({
      list: async () => [{ provider: 'openai-codex', label: 'ChatGPT' }],
      authorize: async (_, interaction, signal) => {
        try { await interaction.prompt({ kind: 'text', message: 'Code' }); return true }
        catch { expect(signal.aborted).toBe(true); return false }
      },
    })
    const result = test.process.connect('openai-codex')
    await vi.waitFor(() => expect(test.view?.prompt).toBeDefined())
    test.view.handleAction('surface.cancel')
    expect(await result).toBe(false)
    expect(test.view).toBeUndefined()
    await test.scope.dispose()
  })

  it('returns the chosen connection result and releases a cancelled selector', async () => {
    const account = { provider: 'openai-codex', label: 'ChatGPT' }
    const authorize = vi.fn(async () => true)
    const test = setup({ list: async () => [account], authorize })
    const selected = test.process.connect()
    await vi.waitFor(() => expect(test.view).toBeDefined())
    expect(test.view.render(100).join('\n')).toContain('ChatGPT')
    test.view.handleAction('surface.confirm')
    expect(await selected).toBe(true)
    expect(authorize).toHaveBeenCalledOnce()
    expect(test.view).toBeUndefined()
    const cancelled = test.process.connect()
    await vi.waitFor(() => expect(test.view).toBeDefined())
    await test.scope.dispose()
    expect(await cancelled).toBe(false)
    expect(test.view).toBeUndefined()
  })
})
