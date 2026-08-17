import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalCommandDirectory,
  type HostCommandSource,
  type TerminalCommandDescriptor,
} from '../../src/runtime/commands.ts'

function hostSource(initial: readonly TerminalCommandDescriptor[] = []): {
  source: HostCommandSource
  execute: ReturnType<typeof vi.fn>
  set(commands: readonly TerminalCommandDescriptor[]): void
} {
  let commands = initial
  let listener = (): void => {}
  const execute = vi.fn(async () => ({ kind: 'success' as const }))
  return {
    source: {
      list: sessionId => sessionId === undefined ? [] : commands,
      execute,
      subscribe: next => {
        listener = next
        return () => { listener = (): void => {} }
      },
    },
    execute,
    set: (next) => {
      commands = next
      listener()
    },
  }
}

describe('TerminalCommandDirectory', () => {
  it('builds help and discovery from one merged local and Host catalog', () => {
    const host = hostSource([
      { name: 'compact', description: 'Compact context', argumentHint: '[focus]' },
      { name: 'status', description: 'Host status' },
    ])
    const changed = vi.fn()
    const directory = new TerminalCommandDirectory([{
      name: 'status',
      description: 'Terminal status',
      handler: vi.fn(),
    }], host.source, changed)

    expect(directory.setSession('session-command' as SessionSummary['sessionId'])).toBe(true)

    expect(directory.descriptors).toEqual([
      { name: 'status', description: 'Terminal status' },
      { name: 'compact', description: 'Compact context', argumentHint: '[focus]' },
    ])
    expect(directory.helpText()).toBe([
      '/status · Terminal status',
      '/compact [focus] · Compact context',
    ].join('\n'))
    expect(changed).not.toHaveBeenCalled()
    directory.dispose()
  })

  it('dispatches local aliases and leaves unknown commands unresolved', async () => {
    const trajectory = vi.fn()
    const directory = new TerminalCommandDirectory([{
      name: 'trajectory',
      aliases: ['trace'],
      description: 'Inspect execution',
      handler: trajectory,
    }])

    await expect(directory.dispatch('/trace current')).resolves.toBe(true)
    expect(trajectory).toHaveBeenCalledWith('current')
    await expect(directory.dispatch('/compact')).resolves.toBe(false)
    directory.dispose()
  })

  it('executes known Host commands through the Host port instead of model input', async () => {
    const host = hostSource([{ name: 'compact', description: 'Compact context', argumentHint: '[focus]' }])
    const directory = new TerminalCommandDirectory([], host.source)
    const sessionId = 'session-command' as SessionSummary['sessionId']
    directory.setSession(sessionId)

    await expect(directory.dispatch('/compact preserve decisions')).resolves.toBe(true)
    expect(host.execute).toHaveBeenCalledWith(sessionId, '/compact preserve decisions', expect.any(AbortSignal))
    directory.dispose()
  })

  it('decorates only the bare Host invocation and keeps argued execution canonical', async () => {
    const host = hostSource([{ name: 'permission', description: 'Switch permission', argumentHint: '<preset>' }])
    const picker = vi.fn()
    const persist = vi.fn(async () => {})
    const directory = new TerminalCommandDirectory(
      [],
      host.source,
      undefined,
      [{ name: 'permission', onBare: picker, afterHostSuccess: persist }],
    )
    const sessionId = 'session-command' as SessionSummary['sessionId']
    directory.setSession(sessionId)

    await expect(directory.dispatch('/permission')).resolves.toBe(true)
    expect(picker).toHaveBeenCalledOnce()
    expect(host.execute).not.toHaveBeenCalled()

    await expect(directory.dispatch('/permission workspace-write')).resolves.toBe(true)
    expect(host.execute).toHaveBeenCalledWith(
      sessionId,
      '/permission workspace-write',
      expect.any(AbortSignal),
    )
    expect(persist).toHaveBeenCalledWith('workspace-write')
    expect(host.execute.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[0] ?? 0)
    directory.dispose()
  })

  it('surfaces Host command failures without running post-success behavior', async () => {
    const host = hostSource([{ name: 'permission', description: 'Switch permission' }])
    host.execute.mockResolvedValueOnce({ kind: 'error', text: 'preset rejected' })
    const persist = vi.fn(async () => {})
    const directory = new TerminalCommandDirectory(
      [],
      host.source,
      undefined,
      [{ name: 'permission', onBare: vi.fn(), afterHostSuccess: persist }],
    )
    directory.setSession('session-command' as SessionSummary['sessionId'])

    await expect(directory.dispatch('/permission invalid')).rejects.toThrow('preset rejected')
    expect(persist).not.toHaveBeenCalled()
    directory.dispose()
  })

  it('refreshes agent-scoped Host discovery without exposing local aliases twice', () => {
    const host = hostSource([{ name: 'trace', description: 'Host trace' }])
    const changed = vi.fn()
    const directory = new TerminalCommandDirectory([{
      name: 'trajectory',
      aliases: ['trace'],
      description: 'Terminal trace',
      handler: vi.fn(),
    }], host.source, changed)
    expect(directory.setSession('session-command' as SessionSummary['sessionId'])).toBe(true)
    expect(directory.descriptors.map(command => command.name)).toEqual(['trajectory'])
    expect(directory.resolutionNames).toEqual(['trajectory', 'trace'])
    expect(directory.has('TRACE')).toBe(true)

    host.set([{ name: 'compact', description: 'Compact context' }])
    expect(directory.descriptors.map(command => command.name)).toEqual(['trajectory', 'compact'])
    expect(changed).toHaveBeenCalledOnce()
    directory.dispose()
  })
})
