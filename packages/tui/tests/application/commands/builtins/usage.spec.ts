import { describe, expect, it, vi } from 'vitest'
import { createUsageCommand, type UsageCommandSession } from '../../../../src/application/commands/builtins/usage.ts'
import type { ProviderUsage } from '../../../../src/modules/usage/contracts.ts'

function setup() {
  let captured = { active: true }
  const session = {
    current: { modelCatalog: {
      default: { provider: 'openai-codex', model: 'gpt-test' },
      routableProviders: ['openai-codex'], groups: [], failures: [],
    }, projections: {} } as UsageCommandSession['current'],
    captureSession: () => captured,
    notice: vi.fn(),
  } satisfies UsageCommandSession
  const read = vi.fn<(provider: string, signal: AbortSignal) => Promise<ProviderUsage | undefined>>()
    .mockResolvedValue(undefined)
  const abort = new AbortController()
  return {
    session, read, abort,
    retire() { captured.active = false },
    nextSession() { captured = { active: true } },
    command: createUsageCommand(session, { read }, abort.signal),
  }
}

describe('/usage', () => {
  it('reads the effective provider and captures a fresh Session on every invocation', async () => {
    const { session, read, command, retire, nextSession } = setup()
    await command.handler('')
    retire()
    nextSession()
    session.current = { ...session.current, projections: { modelSelection: {
      next: { provider: 'another-provider', model: 'next-model' },
    } } as UsageCommandSession['current']['projections'] }
    await command.handler('')
    expect(read.mock.calls.map(([provider]) => provider)).toEqual(['openai-codex', 'another-provider'])
    expect(session.notice).toHaveBeenLastCalledWith('Subscription usage is not available for another-provider.')
  })

  it('rejects a missing model instead of swallowing the prerequisite error as provider feedback', async () => {
    const { session, command, read } = setup()
    session.current = { ...session.current, modelCatalog: undefined }
    await expect(command.handler('')).rejects.toThrow('Select a model with /model before checking usage.')
    expect(read).not.toHaveBeenCalled()
    expect(session.notice).not.toHaveBeenCalled()
  })

  it.each([
    { lifetime: 'retired', outcome: 'success' },
    { lifetime: 'aborted', outcome: 'failure' },
  ] as const)('suppresses late $outcome feedback after the invocation is $lifetime', async ({ lifetime, outcome }) => {
    const pending = Promise.withResolvers<ProviderUsage | undefined>()
    const { session, read, command, abort, retire } = setup()
    read.mockReturnValue(pending.promise)
    const run = command.handler('')
    if (lifetime === 'retired') retire()
    else abort.abort()
    if (outcome === 'success') pending.resolve({ provider: 'openai-codex', checkedAt: 0, groups: [] })
    else pending.reject(new Error('Late provider failure'))
    await run
    expect(session.notice).not.toHaveBeenCalled()
  })
})
