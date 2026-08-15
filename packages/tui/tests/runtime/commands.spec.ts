import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalCommandDirectory,
  type HostCommandSource,
  type TerminalCommandDescriptor,
} from '../../src/runtime/commands.ts'

function hostSource(initial: readonly TerminalCommandDescriptor[] = []): {
  source: HostCommandSource
  set(commands: readonly TerminalCommandDescriptor[]): void
} {
  let commands = initial
  let listener = (): void => {}
  return {
    source: {
      list: sessionId => sessionId === undefined ? [] : commands,
      subscribe: next => {
        listener = next
        return () => { listener = (): void => {} }
      },
    },
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

  it('dispatches local aliases and leaves Host commands unresolved for ApiProxy', async () => {
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

    host.set([{ name: 'compact', description: 'Compact context' }])
    expect(directory.descriptors.map(command => command.name)).toEqual(['trajectory', 'compact'])
    expect(changed).toHaveBeenCalledOnce()
    directory.dispose()
  })
})
