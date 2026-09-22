import type { SessionSummary } from '../../../src/runtime/session/contracts.ts'
import { describe, expect, it, vi } from 'vitest'
import type {
  HostCommandSource,
  TerminalCommandDescriptor,
} from '../../../src/application/commands/contracts.ts'
import { TerminalCommandDirectory } from '../../../src/application/commands/directory.ts'

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
  it('publishes the assembled local catalog and decorations after session binding', async () => {
    const host = hostSource([
      { name: 'trace', description: 'Host trace' },
      { name: 'permission', description: 'Switch permission' },
    ])
    const directory = new TerminalCommandDirectory(undefined, host.source)
    directory.setSession('session-command' as SessionSummary['sessionId'])
    const changed = vi.fn(() => directory.descriptors.map(command => command.name))
    directory.subscribe(changed)
    const trace = vi.fn()
    const picker = vi.fn()

    directory.initialize([{
      name: 'trajectory',
      aliases: ['trace'],
      description: 'Terminal trace',
      handler: trace,
    }], [{ name: 'permission', onBare: picker }])

    expect(changed).toHaveBeenCalledOnce()
    expect(changed.mock.results[0]?.value).toEqual(['trajectory', 'permission'])
    await expect(directory.dispatch('/trace current')).resolves.toBe(true)
    expect(trace).toHaveBeenCalledWith('current')
    await expect(directory.dispatch('/permission')).resolves.toBe(true)
    expect(picker).toHaveBeenCalledOnce()
    expect(host.execute).not.toHaveBeenCalled()
    directory.dispose()
  })

  it.each(['constructor', 'initialize'] as const)('accepts static assembly only once via %s', (assembly) => {
    const directory = new TerminalCommandDirectory(assembly === 'constructor' ? [] : undefined)
    if (assembly === 'initialize') directory.initialize([])
    expect(() => directory.initialize([])).toThrow('already initialized')
    directory.dispose()
  })

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
    }], host.source)
    directory.subscribe(changed)

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

  it('resolves activity labels from the effective command, respecting local aliases and shadowing', () => {
    const host = hostSource([
      { name: 'compact', description: 'Compact context' },
      { name: 'status', description: 'Host status' },
    ])
    const directory = new TerminalCommandDirectory([{
      name: 'usage',
      aliases: ['quota'],
      description: 'Check quota',
      activityLabel: 'Checking subscription usage',
      handler: vi.fn(),
    }, {
      name: 'status',
      description: 'Terminal status',
      handler: vi.fn(),
    }], host.source)
    directory.setSession('session-command' as SessionSummary['sessionId'])

    expect(directory.activityLabel('QUOTA')).toBe('Checking subscription usage')
    expect(directory.activityLabel('compact')).toBe('Running /compact')
    expect(directory.activityLabel('status')).toBeUndefined()
    expect(directory.activityLabel('unknown')).toBeUndefined()
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

  it.each(['session change', 'dispose'] as const)('cancels pending Host execution on %s', async (reason) => {
    const host = hostSource([{ name: 'compact', description: 'Compact context' }])
    host.execute.mockImplementation((_sessionId: unknown, _line: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      }))
    const directory = new TerminalCommandDirectory([], host.source)
    directory.setSession('session-command' as SessionSummary['sessionId'])
    const pending = directory.dispatch('/compact')
    const rejected = expect(pending).rejects.toThrow('Host command session changed')

    if (reason === 'session change') directory.setSession(undefined)
    else directory.dispose()

    await rejected
    directory.dispose()
  })

  it('removes source and discovery subscriptions when disposed', () => {
    const host = hostSource([{ name: 'compact', description: 'Compact context' }])
    const directory = new TerminalCommandDirectory([], host.source)
    directory.setSession('session-command' as SessionSummary['sessionId'])
    const changed = vi.fn()
    directory.subscribe(changed)
    directory.dispose()

    host.set([{ name: 'status', description: 'Host status' }])
    expect(directory.descriptors.map(command => command.name)).toEqual(['compact'])
    expect(changed).not.toHaveBeenCalled()
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
      [{ name: 'permission', onBare: picker, afterHostSuccess: persist }],
    )
    const sessionId = 'session-command' as SessionSummary['sessionId']
    directory.setSession(sessionId)

    await expect(directory.dispatch('/permission')).resolves.toBe(true)
    expect(picker).toHaveBeenCalledOnce()
    expect(host.execute).not.toHaveBeenCalled()

    const execution = Promise.withResolvers<{ kind: 'success' }>()
    host.execute.mockReturnValueOnce(execution.promise)
    const pending = directory.dispatch('/permission workspace-write')
    expect(persist).not.toHaveBeenCalled()
    execution.resolve({ kind: 'success' })
    await expect(pending).resolves.toBe(true)
    expect(host.execute).toHaveBeenCalledWith(
      sessionId,
      '/permission workspace-write',
      expect.any(AbortSignal),
    )
    expect(persist).toHaveBeenCalledWith('workspace-write')
    directory.dispose()
  })

  it('surfaces Host command failures without running post-success behavior', async () => {
    const host = hostSource([{ name: 'permission', description: 'Switch permission' }])
    host.execute.mockResolvedValueOnce({ kind: 'error', text: 'preset rejected' })
    const persist = vi.fn(async () => {})
    const directory = new TerminalCommandDirectory(
      [],
      host.source,
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
    }], host.source)
    directory.subscribe(changed)
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
