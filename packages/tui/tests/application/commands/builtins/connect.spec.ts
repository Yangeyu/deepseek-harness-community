import { describe, expect, it, vi } from 'vitest'
import { createConnectCommand } from '../../../../src/application/commands/builtins/connect.ts'

describe('/connect', () => {
  it.each([
    ['', true, 'Provider connected. Use /model to select a model.'],
    ['openai-codex', false, 'Sign-in cancelled.'],
  ] as const)('connects %s and reports the authentication outcome', async (argument, connected, message) => {
    const connect = vi.fn(async (_provider?: string) => connected)
    const notice = vi.fn()
    const command = createConnectCommand({ connect }, { notice }, new AbortController().signal)
    await command.handler(argument)
    expect(connect).toHaveBeenCalledWith(argument === '' ? undefined : argument)
    expect(notice).toHaveBeenCalledWith(message)
  })

  it('does not post sign-in feedback after the application command lifetime ends', async () => {
    const signIn = Promise.withResolvers<boolean>()
    const abort = new AbortController()
    const notice = vi.fn()
    const command = createConnectCommand({ connect: () => signIn.promise }, { notice }, abort.signal)
    const pending = command.handler('openai-codex')
    abort.abort()
    signIn.resolve(true)
    await pending
    expect(notice).not.toHaveBeenCalled()
  })

  it('propagates authentication failures to normal command error handling', async () => {
    const error = new Error('Authentication failed')
    const command = createConnectCommand({ connect: async () => { throw error } }, { notice: vi.fn() }, new AbortController().signal)
    await expect(command.handler('')).rejects.toBe(error)
  })
})
