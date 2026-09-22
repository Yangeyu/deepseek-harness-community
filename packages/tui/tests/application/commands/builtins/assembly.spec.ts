import { describe, expect, it, vi } from 'vitest'
import { createBuiltinCommands, type BuiltinCommandOptions } from '../../../../src/application/commands/index.ts'
import { TerminalCommandDirectory } from '../../../../src/application/commands/directory.ts'

function options() {
  return {
    session: {
      current: {
        events: [], historyHasMore: false, modelCatalog: undefined, projections: {},
        sessionId: undefined, cwd: '/workspace', runState: 'idle',
        connection: { events: 'online', control: 'online' }, queue: [],
      },
      captureSession: () => ({ active: true }),
      loadEarlierHistory: async () => false,
      notice() {},
      clearSession: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
    },
    composer: { attachPath: vi.fn(async (_path: string) => {}), async pasteImage() {} },
    configuration: {
      openModelSelector: vi.fn(async () => {}),
      selectNamedModel: vi.fn(async (_model: string) => {}),
      details: false,
      setDetails() {},
      openRoute() {},
      openPermission() {},
    },
    sessionCenter: { open: vi.fn(async () => {}), resume: vi.fn(async (_id: string) => {}) },
    layout: { followTranscript: vi.fn() },
    skills: { open() {} },
    task: { open() {} },
    trajectory: { open() {} },
    memory: { async open() {} },
    rewind: { request() {} },
    exit: { async request() {} },
    async clipboardText() {},
    signal: new AbortController().signal,
    help: { helpText: () => 'Current command help' },
  } satisfies BuiltinCommandOptions
}

function assemble(dependencies = options()) {
  const { local, decorations } = createBuiltinCommands(dependencies)
  return { dependencies, directory: new TerminalCommandDirectory(local, undefined, decorations) }
}

describe('built-in command assembly', () => {
  it('registers the command catalog and aliases, adding optional provider capabilities first', () => {
    const required = [
      'help', 'clear', 'new', 'resume', 'model', 'attach', 'paste-image', 'copy', 'details',
      'skills', 'config', 'vision', 'web', 'task', 'trajectory', 'status', 'memories', 'rewind', 'exit',
    ]
    const dependencies = options()
    const { local } = createBuiltinCommands(dependencies)
    expect(local.map(command => command.name)).toEqual(required)
    expect(local.filter(command => command.aliases).map(({ name, aliases }) => [name, aliases])).toEqual([
      ['trajectory', ['trace']], ['memories', ['memory']], ['exit', ['quit']],
    ])
    const enabled = createBuiltinCommands({
      ...dependencies,
      authentication: { connect: async () => true },
      usage: { read: async () => undefined },
    })
    expect(enabled.local.map(command => command.name)).toEqual(['connect', 'usage', ...required])
  })

  it('supports clearing, starting, and resuming conversations through Session commands', async () => {
    const { dependencies, directory } = assemble()
    dependencies.session.clearSession.mockImplementation(async () => {
      expect(dependencies.layout.followTranscript).toHaveBeenCalledOnce()
    })
    await directory.dispatch('/clear')
    await directory.dispatch('/new')
    await directory.dispatch('/resume')
    await directory.dispatch('/resume another-session')
    expect(dependencies.session.clearSession).toHaveBeenCalledOnce()
    expect(dependencies.session.newSession).toHaveBeenCalledOnce()
    expect(dependencies.sessionCenter.open).toHaveBeenCalledOnce()
    expect(dependencies.sessionCenter.resume).toHaveBeenCalledWith('another-session')
    directory.dispose()
  })

  it('opens the model picker or selects the model supplied in the command', async () => {
    const { dependencies, directory } = assemble()
    await directory.dispatch('/model')
    await directory.dispatch('/model provider/model')
    expect(dependencies.configuration.openModelSelector).toHaveBeenCalledOnce()
    expect(dependencies.configuration.selectNamedModel).toHaveBeenCalledWith('provider/model')
    directory.dispose()
  })

  it('requires an attachment path and preserves spaces inside it', async () => {
    const { dependencies, directory } = assemble()
    await expect(directory.dispatch('/attach   ')).rejects.toThrow('Usage: /attach <path>')
    await directory.dispatch('/attach   /workspace/my image.png   ')
    expect(dependencies.composer.attachPath).toHaveBeenCalledExactlyOnceWith('/workspace/my image.png')
    directory.dispose()
  })
})
