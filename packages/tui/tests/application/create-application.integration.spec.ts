import {
  stripTerminalSequences,
  type Terminal,
} from '@earendil-works/pi-tui'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApplication,
  type ApplicationAssembly,
  type TuiApplicationDependencies,
  type TuiMemoryPort,
} from '../../src/application/create-application.ts'
import type { TuiRuntime } from '../../src/application/contracts.ts'
import type { TuiHostPorts } from '../../src/application/host-ports.ts'
import type { RewindPlan, RewindPort } from '../../src/modules/rewind/index.ts'
import { resolveConfig } from '../../src/application/config.ts'
import type { RuntimeSessionSnapshot } from '../../src/runtime/session/manager.ts'
import type { HostCommandSource, HostCommandResult } from '../../src/runtime/commands.ts'
import type { VisionGateway } from '../../src/modules/composer/attachments/coordinator.ts'
import type { NewAttachmentDraft } from '../../src/modules/composer/attachments/drafts.ts'
import { buildExecutionSnapshot } from '../../src/runtime/execution/projection/index.ts'
import type {
  ApprovalPrompt,
  InteractionResolution,
} from '../../src/runtime/session/interactions.ts'
import { decodeTerminalInput } from '../../src/infrastructure/terminal/decode-input.ts'
import type { HistoryEntry } from '../../src/runtime/session/contracts.ts'

function hostPorts(): TuiHostPorts {
  const unavailable = async (): Promise<never> => { throw new Error('Host port is not configured for this test') }
  const emptyStream = async function*(): AsyncGenerator<never> {}
  return {
    sessions: {
      describeHost: async () => ({ cwd: '/workspace' }),
      listSessions: async () => [],
      createSession: unavailable,
      forkSession: unavailable,
      page: unavailable,
      modelCatalog: unavailable,
      selectModel: unavailable,
      prompt: unavailable,
      cancel: unavailable,
      openPath: unavailable,
      follow: emptyStream,
      control: emptyStream,
      onStatus: () => () => {},
      onError: () => () => {},
    },
    interactions: { connect: () => () => {} },
    fileReferences: { list: async () => [] },
    skills: { list: async () => [] },
    goals: () => ({
      create: unavailable,
      edit: unavailable,
      pause: unavailable,
      resume: unavailable,
      complete: unavailable,
      clear: unavailable,
    }),
  }
}

function sendInput(internals: ApplicationAssembly, data: string): { consume?: boolean } | undefined {
  return internals.input.handle(decodeTerminalInput(data))
}

function memoryService(overrides: Partial<TuiMemoryPort> = {}): TuiMemoryPort {
  return {
    onActivity: () => () => {},
    overview: async () => { throw new Error('no test Memory overview') },
    setPolicy: () => { throw new Error('no test Memory policy') },
    policy: () => { throw new Error('no test Memory policy') },
    ...overrides,
  }
}

function rewindPort(overrides: Partial<RewindPort> = {}): RewindPort {
  return {
    activate: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    list: vi.fn(() => []),
    plan: vi.fn(async () => { throw new Error('no test Rewind plan') }),
    restore: vi.fn(async () => async () => {}),
    commit: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  }
}

function rewindPlan(attachments: readonly ImageAttachmentRef[] = []): RewindPlan {
  return {
    planId: 'plan-1',
    pointId: 'point-1',
    sessionId: 'session-1',
    turn: 1,
    input: {
      text: attachments.length === 0 ? 'inspect image' : 'inspect [Image #1]',
      attachments,
    },
    createdAt: 1,
    codeScope: 'backward',
    state: 'safe',
    files: [],
    participants: [],
  }
}

function approvalPrompt(): ApprovalPrompt {
  return {
    sessionId: 'session-1',
    requestId: 'approval-1',
    toolName: 'shell',
    reason: 'The command needs workspace access.',
  } as ApprovalPrompt
}

function approvalResolution(
  prompt: ApprovalPrompt,
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable',
): InteractionResolution {
  return {
    type: 'approval/resolved',
    sessionId: prompt.sessionId,
    requestId: prompt.requestId,
    outcome,
  }
}

function quietTerminal(): Terminal {
  return {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start: vi.fn(),
    stop: vi.fn(),
    drainInput: vi.fn(async () => {}),
    write: vi.fn(),
    moveBy: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    clearLine: vi.fn(),
    clearFromCursor: vi.fn(),
    clearScreen: vi.fn(),
    setTitle: vi.fn(),
    setProgress: vi.fn(),
  }
}

interface TestApplication extends ApplicationAssembly {
  start(): Promise<void>
  dispose(): Promise<void>
}

function application(
  rewind: RewindPort = rewindPort(),
  memory: TuiMemoryPort = memoryService(),
  runtimeOverrides: Partial<TuiRuntime> = {},
  commandSource?: HostCommandSource,
  dependencies: TuiApplicationDependencies = {},
): TestApplication {
  const runtime: TuiRuntime = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: vi.fn(),
    ...runtimeOverrides,
  }
  const assembly = createApplication(
    hostPorts(),
    resolveConfig({ cwd: '/workspace', color: false }),
    runtime,
    rewind,
    memory,
    {
      terminal: quietTerminal(),
      gitBranch: (_cwd, onChange) => {
        onChange(undefined)
        return () => {}
      },
      ...dependencies,
      ...commandSource === undefined ? {} : { commandSource },
    },
  )
  assembly.tui.requestRender = vi.fn()
  return Object.assign(assembly, {
    start: () => assembly.application.start(),
    dispose: () => assembly.application.dispose(),
  })
}

function visionFixture(): VisionGateway {
  return {
    config: {
      mode: 'auto',
      proxyProvider: 'proxy',
      proxyModel: 'vision',
      maxObservationChars: 12_000,
      maxTokens: 2_048,
    },
  } as VisionGateway
}

function clipboardPng(): NewAttachmentDraft {
  return {
    name: 'clipboard.png',
    mediaType: 'image/png',
    data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
    source: 'clipboard',
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createApplication integration', () => {
  it('clears an idle draft before Ctrl+C exits an empty composer', async () => {
    const exit = vi.fn()
    const app = application(undefined, undefined, { exit })
    const internals = app
    internals.composer.editor.setText('unfinished prompt')

    expect(sendInput(internals, '\u0003')).toEqual({ consume: true })
    expect(internals.composer.editor.getExpandedText()).toBe('')
    expect(internals.status.render(100).join('\n')).toContain('Input cleared · ↑ to restore')
    expect(exit).not.toHaveBeenCalled()

    expect(sendInput(internals, '\u0003')).toEqual({ consume: true })
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
  })

  it('Ctrl+C clears a draft while working instead of interrupting', () => {
    const exit = vi.fn()
    const app = application(undefined, undefined, { exit })
    const internals = app
    const cancel = vi.fn(async () => {})
    internals.session.cancel = cancel
    const idleState = internals.session.current
    vi.spyOn(internals.session, 'current', 'get').mockReturnValue({
      ...idleState,
      runState: 'running',
      execution: buildExecutionSnapshot({
        sessionId: undefined,
        epoch: 1,
        entries: [],
        sessionRunning: true,
      }),
    })
    internals.composer.editor.setText('queued thought')

    expect(sendInput(internals, '\u0003')).toEqual({ consume: true })
    expect(internals.composer.editor.getExpandedText()).toBe('')
    expect(cancel).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()

    expect(sendInput(internals, '\u0003')).toEqual({ consume: true })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('exits on repeated Ctrl+C when an interrupted runtime never becomes idle', async () => {
    const exit = vi.fn()
    const write = vi.fn(() => true)
    const app = application(undefined, undefined, {
      exit,
      stdout: { write } as unknown as NodeJS.WriteStream,
    })
    const internals = app
    const current = internals.session.current
    vi.spyOn(internals.session, 'current', 'get').mockReturnValue({
      ...current,
      sessionId: 'session-stuck' as RuntimeSessionSnapshot['sessionId'],
      runState: 'running',
      execution: buildExecutionSnapshot({
        sessionId: 'session-stuck',
        epoch: 1,
        entries: [],
        sessionRunning: true,
      }),
    })
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    internals.session.cancel = cancel

    expect(sendInput(internals, '\u0003')).toEqual({ consume: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    expect(internals.status.render(100).join('\n')).toContain('Ctrl+C again to exit')

    expect(sendInput(internals, '\u0003')).toEqual({ consume: true })
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
  })

  it('applies one ordered startup intent before submitting its initial prompt', async () => {
    const events: string[] = []
    const setDefaultPreset = vi.fn(async () => {})
    const app = application(
      undefined,
      undefined,
      {
        stdin: { isTTY: true } as NodeJS.ReadStream,
        stdout: { isTTY: true, write: vi.fn() } as unknown as NodeJS.WriteStream,
      },
      undefined,
      {
        permissionDefault: { setDefaultPreset },
        startup: {
          resume: { kind: 'last' },
          prompt: 'continue the task',
          imagePaths: [],
          permissionMode: 'workspace-write',
          plan: true,
        },
      },
    )
    const internals = app as unknown as {
      session: {
        sessions(): Promise<Array<{ sessionId: string; blank: boolean }>>
        start(sessionId?: string): Promise<void>
      }
      commands: { dispatchHost(command: string): Promise<void> }
      composer: { submit(prompt: string): Promise<void> }
    }
    internals.session.sessions = vi.fn(async () => [
      { sessionId: 'blank', blank: true },
      { sessionId: 'latest-subagent', blank: false, origin: 'subagent' },
      { sessionId: 'latest-conversation', blank: false },
    ])
    internals.session.start = vi.fn(async (sessionId) => { events.push(`start:${sessionId ?? ''}`) })
    internals.commands.dispatchHost = vi.fn(async command => { events.push(command) })
    internals.composer.submit = vi.fn(async prompt => { events.push(`prompt:${prompt}`) })

    await app.start()

    expect(events).toEqual([
      'start:latest-conversation',
      '/permission workspace-write',
      '/plan',
      'prompt:continue the task',
    ])
    expect(setDefaultPreset).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('restores the terminal and releases application resources when startup fails', async () => {
    const terminal = quietTerminal()
    const removeMemoryActivity = vi.fn()
    const app = application(
      undefined,
      memoryService({ onActivity: () => removeMemoryActivity }),
      {
        stdin: { isTTY: true } as NodeJS.ReadStream,
        stdout: { isTTY: true, write: vi.fn() } as unknown as NodeJS.WriteStream,
      },
      undefined,
      { terminal },
    )
    const internals = app as unknown as {
      session: { start(): Promise<void> }
    }
    internals.session.start = vi.fn(async () => { throw new Error('Host unavailable') })

    await expect(app.start()).rejects.toThrow('Host unavailable')

    expect(terminal.stop).toHaveBeenCalledOnce()
    expect(terminal.drainInput).toHaveBeenCalledWith(250, 30)
    expect(removeMemoryActivity).toHaveBeenCalledOnce()
    await app.dispose()
    expect(terminal.stop).toHaveBeenCalledOnce()
    expect(removeMemoryActivity).toHaveBeenCalledOnce()
  })

  it('keeps slash suggestions above the same bottom-anchored input row', async () => {
    const app = application()
    const internals = app

    for (const character of '/he') internals.composer.editor.handleInput(character)
    const before = internals.layout.render(80).map(stripTerminalSequences)
    const inputRow = before.findIndex(line => line.includes('/he'))

    await vi.waitFor(() => { expect(internals.composer.editor.isShowingAutocomplete()).toBe(true) })
    const after = internals.layout.render(80).map(stripTerminalSequences)
    const suggestionRow = after.findIndex(line => line.includes('help'))
    const inputRowWithSuggestions = after.findIndex(line => line.includes('/he'))

    expect(inputRow).toBeGreaterThanOrEqual(0)
    expect(inputRowWithSuggestions).toBe(inputRow)
    expect(suggestionRow).toBeGreaterThanOrEqual(0)
    expect(suggestionRow).toBeLessThan(inputRowWithSuggestions)
  })

  it('copies a dragged selection from the active Trajectory surface', async () => {
    const clipboardText = vi.fn(async () => {})
    const app = application(undefined, undefined, undefined, undefined, { clipboardText })
    const internals = app
    internals.trajectory.open()
    expect(internals.surfaces.active).toBe(true)
    internals.layout.transcriptRowAt = vi.fn(() => 0)
    internals.transcript.handlePointer = vi.fn(() => false)
    internals.tui.beginTextSelection = vi.fn(() => true)
    internals.tui.updateTextSelection = vi.fn(() => true)
    internals.tui.finishTextSelection = vi.fn(() => ({
      kind: 'selection' as const,
      changed: false,
      text: 'selected output',
    }))

    sendInput(internals, '\u001b[<0;1;1M')
    sendInput(internals, '\u001b[<32;8;1M')
    sendInput(internals, '\u001b[<0;8;1m')
    await vi.waitFor(() => { expect(clipboardText).toHaveBeenCalledWith('selected output') })

    expect(internals.transcript.handlePointer).not.toHaveBeenCalledWith(0, 'click')
  })

  it('routes Trajectory clicks and wheel input to the rendered pane', () => {
    const terminal = { ...quietTerminal(), columns: 140, rows: 10 }
    const app = application(undefined, undefined, undefined, undefined, { terminal })
    const internals = app
    const events = [
      { event: { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } } },
      { event: { type: 'step/start', seq: 1, time: 1_100, data: { turn: 1, step: 1 } } },
    ] as unknown as HistoryEntry[]
    const state = {
      ...internals.session.current,
      events,
      execution: buildExecutionSnapshot({
        sessionId: undefined,
        epoch: 0,
        entries: events,
        sessionRunning: false,
      }),
    } satisfies RuntimeSessionSnapshot

    internals.trajectory.open()
    const view = internals.trajectory.activeView
    if (view === undefined) throw new Error('expected active Trajectory view')
    view.setState(state)
    const latest = view.snapshot.selectedKey
    expect(view.snapshot.records).toBe(2)

    const initial = internals.tui.render(140).map(stripTerminalSequences)
    const firstRecordRow = initial.findIndex(line => line.includes('TURN') && line.includes('Turn 1'))
    const paneHeaderRow = initial.findIndex(line => line.includes('EXECUTION') && line.includes('DETAIL'))
    const executionColumn = initial[paneHeaderRow]?.indexOf('EXECUTION') ?? -1
    expect(firstRecordRow).toBeGreaterThanOrEqual(0)
    expect(paneHeaderRow).toBeGreaterThanOrEqual(0)
    expect(executionColumn).toBeGreaterThanOrEqual(0)
    sendInput(internals, `\u001b[<0;${String(executionColumn + 1)};${String(firstRecordRow + 1)}M`)
    sendInput(internals, `\u001b[<0;${String(executionColumn + 1)};${String(firstRecordRow + 1)}m`)
    const selected = view.snapshot.selectedKey
    expect(selected).not.toBe(latest)

    const detailTopLines = internals.tui.render(140).map(stripTerminalSequences)
    const detailColumn = detailTopLines[paneHeaderRow]?.indexOf('DETAIL') ?? -1
    const detailTop = detailTopLines.join('\n')
    expect(detailColumn).toBeGreaterThan(executionColumn)
    expect(detailTop).toMatch(/1-1\/\d+/u)
    sendInput(internals, `\u001b[<65;${String(detailColumn + 1)};${String(paneHeaderRow + 1)}M`)
    expect(view.snapshot.selectedKey).toBe(selected)
    const detailScrolled = internals.tui.render(140).map(stripTerminalSequences).join('\n')
    expect(detailScrolled).toMatch(/2-2\/\d+/u)

    const tabRow = detailTopLines.findIndex(line => line.includes('[Summary]') && line.includes('Output'))
    const outputColumn = detailTopLines[tabRow]?.indexOf('Output') ?? -1
    expect(tabRow).toBeGreaterThanOrEqual(0)
    expect(outputColumn).toBeGreaterThan(detailColumn)
    sendInput(internals, `\u001b[<0;${String(outputColumn + 1)};${String(tabRow + 1)}M`)
    sendInput(internals, `\u001b[<0;${String(outputColumn + 1)};${String(tabRow + 1)}m`)
    const outputTab = internals.tui.render(140).map(stripTerminalSequences).join('\n')
    expect(outputTab).toContain('[Output]')
    expect(outputTab).toContain('No result recorded for this event.')

    sendInput(internals, `\u001b[<65;${String(executionColumn + 1)};${String(paneHeaderRow + 1)}M`)
    expect(view.snapshot.selectedKey).toBe(latest)
  })

  it('dispatches a title click only after a primary-button gesture ends without selection', () => {
    const app = application()
    const internals = app
    internals.layout.transcriptRowAt = vi.fn(() => 0)
    const handlePointer = vi.fn(() => true)
    internals.transcript.handlePointer = handlePointer
    internals.transcript.isTrailingBlock = vi.fn(() => false)
    internals.layout.preserveTranscriptViewport = vi.fn()
    internals.tui.beginTextSelection = vi.fn(() => true)
    internals.tui.finishTextSelection = vi.fn(() => ({ kind: 'click' as const, changed: false }))

    sendInput(internals, '\u001b[<0;1;1M')
    expect(handlePointer).not.toHaveBeenCalledWith(0, 'click')
    expect(internals.layout.preserveTranscriptViewport).not.toHaveBeenCalled()

    sendInput(internals, '\u001b[<0;1;1m')
    expect(handlePointer).toHaveBeenCalledWith(0, 'click')
    expect(internals.layout.preserveTranscriptViewport).toHaveBeenCalledOnce()
  })

  it('keeps tail following when the clicked disclosure block reaches the transcript end', () => {
    const app = application()
    const internals = app
    internals.layout.transcriptRowAt = vi.fn(() => 0)
    const handlePointer = vi.fn(() => true)
    internals.transcript.handlePointer = handlePointer
    internals.transcript.isTrailingBlock = vi.fn(() => true)
    internals.layout.preserveTranscriptViewport = vi.fn()
    internals.tui.beginTextSelection = vi.fn(() => true)
    internals.tui.finishTextSelection = vi.fn(() => ({ kind: 'click' as const, changed: false }))

    sendInput(internals, '\u001b[<0;1;1m')

    expect(handlePointer).toHaveBeenCalledWith(0, 'click')
    expect(internals.transcript.isTrailingBlock).toHaveBeenCalledWith(0)
    expect(internals.layout.preserveTranscriptViewport).not.toHaveBeenCalled()
  })

  it('coalesces hover invalidations when the pointer enters or leaves a fold title', async () => {
    const app = application()
    const internals = app
    internals.layout.transcriptRowAt = vi.fn(() => 0)
    const handlePointer = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    internals.transcript.handlePointer = handlePointer
    const requestRender = vi.mocked(internals.tui.requestRender)

    sendInput(internals, '\u001b[<35;1;1M')
    sendInput(internals, '\u001b[<35;2;1M')
    internals.layout.transcriptRowAt = vi.fn(() => 4)
    sendInput(internals, '\u001b[<35;2;5M')

    expect(handlePointer).toHaveBeenNthCalledWith(1, 0, 'move')
    expect(handlePointer).toHaveBeenNthCalledWith(2, 0, 'move')
    expect(handlePointer).toHaveBeenNthCalledWith(3, 4, 'move')
    await Promise.resolve()
    expect(requestRender).toHaveBeenCalledOnce()
  })

  it('renders approval in the composer surface without leaking wheel input to the transcript', () => {
    const app = application()
    const internals = app
    const prompt = approvalPrompt()
    const scrollTranscript = vi.fn(() => true)
    const scrollSurface = vi.fn(() => false)
    internals.layout.scrollTranscript = scrollTranscript
    internals.layout.scrollSurface = scrollSurface
    internals.transcript.handlePointer = vi.fn(() => false)

    internals.interactions.requestApproval(prompt)
    expect(internals.surfaces.active).toBe(true)
    const approval = internals.layout.render(80)
      .map(line => stripTerminalSequences(line).trimEnd())
      .join('\n')
    expect(approval).toContain('╭─ Permission required · shell ─')
    expect(approval).toContain('Allow once')
    expect(approval).toContain('Reject and continue')
    expect(approval).toContain('╰─ ↑/↓ select · Enter confirm · Esc/Ctrl+C interrupt task ─')

    expect(sendInput(internals, '\u001b[<64;8;9M')).toEqual({ consume: true })
    expect(scrollSurface).toHaveBeenCalledWith(-1)
    expect(scrollTranscript).not.toHaveBeenCalled()
    expect(internals.transcript.handlePointer).not.toHaveBeenCalledWith(expect.any(Number), 'wheel-up')

    internals.interactions.resolve(approvalResolution(prompt, 'cancelled'))
    expect(internals.surfaces.active).toBe(false)
    expect(internals.tui.getFocusedComponent()).toBe(internals.composer.editor)
  })

  it('uses Ctrl+V as the image paste shortcut', () => {
    const app = application()
    const internals = app
    const pasteImage = vi.fn(async () => {})
    internals.composer.pasteImage = pasteImage

    expect(sendInput(internals, '\u0016')).toEqual({ consume: true })
    expect(pasteImage).toHaveBeenCalledTimes(1)
  })

  it('suppresses key repeat and release events before invoking image paste', () => {
    const app = application()
    const internals = app
    const pasteImage = vi.fn(async () => {})
    internals.composer.pasteImage = pasteImage

    expect(sendInput(internals, '\u001b[118;5u')).toEqual({ consume: true })
    expect(sendInput(internals, '\u001b[118;5:2u')).toEqual({ consume: true })
    expect(sendInput(internals, '\u001b[118;5:3u')).toEqual({ consume: true })
    expect(pasteImage).toHaveBeenCalledOnce()
  })

  it('anchors one coalesced clipboard image at the invocation cursor before loading completes', async () => {
    let resolveClipboard!: (draft: NewAttachmentDraft) => void
    const clipboardImage = vi.fn(() => new Promise<NewAttachmentDraft>((resolve) => {
      resolveClipboard = resolve
    }))
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage,
    })
    const internals = app
    internals.composer.editor.setText('beforeafter')
    for (let index = 0; index < 5; index += 1) internals.composer.editor.handleInput('\u001b[D')

    const first = internals.composer.pasteImage()
    const second = internals.composer.pasteImage()
    expect(clipboardImage).toHaveBeenCalledOnce()
    expect(internals.composer.editor.getExpandedText()).toBe('before [Image #1] after')
    resolveClipboard(clipboardPng())
    await Promise.all([first, second])

    expect(internals.composer.current.attachments).toHaveLength(1)
    expect(internals.composer.current.attachments[0]?.placeholder).toBe('[Image #1]')
    expect(internals.composer.editorFrame.render(80).join('\n')).toContain('[Image #1]')
  })

  it('retains a Composer image created by the paste-image command', async () => {
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => clipboardPng(),
    })
    const internals = app

    await internals.composer.submit('/paste-image')

    expect(internals.composer.editor.getExpandedText()).toBe('[Image #1] ')
    expect(internals.composer.current.attachments).toEqual([
      expect.objectContaining({ placeholder: '[Image #1]', name: 'clipboard.png' }),
    ])
  })

  it('treats an inline image reference as one editing unit', async () => {
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => clipboardPng(),
    })
    const internals = app
    await internals.composer.pasteImage()

    internals.composer.editor.handleInput('\u007F')
    expect(internals.composer.editor.getExpandedText()).toBe('[Image #1]')
    internals.composer.editor.handleInput('\u001b[D')
    expect(internals.composer.editor.getCursor().col).toBe(0)
    internals.composer.editor.handleInput('\u001b[C')
    expect(internals.composer.editor.getCursor().col).toBe('[Image #1]'.length)
    internals.composer.editor.handleInput('\u007F')
    expect(internals.composer.editor.getExpandedText()).toBe('')
    expect(internals.composer.current.attachments).toEqual([])

    internals.composer.editor.handleInput('\u001F')
    expect(internals.composer.editor.getExpandedText()).toBe('[Image #1]')
    expect(internals.composer.current.attachments).toHaveLength(1)

    expect(sendInput(internals, '\u001b\u007F')).toEqual({ consume: true })
    expect(internals.composer.current.attachments).toEqual([])
    expect(internals.composer.editor.getExpandedText()).toBe('')
    expect(internals.composer.editorFrame.render(80).join('\n')).not.toContain('[Image #1]')

    internals.composer.editor.handleInput('\u001F')
    expect(internals.composer.editor.getExpandedText()).toBe('[Image #1]')
    expect(internals.composer.current.attachments).toHaveLength(1)

    internals.composer.editor.handleInput('\u0015')
    expect(internals.composer.editor.getExpandedText()).toBe('')
    expect(internals.composer.current.attachments).toEqual([])
    internals.composer.editor.handleInput('\u001F')
    expect(internals.composer.current.attachments).toHaveLength(1)
  })

  it('restores complete Prompt text and durable images after a successful Rewind', async () => {
    const ref: ImageAttachmentRef = {
      attachmentId: 'attachment-1' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'image.png',
    }
    const restore = vi.fn(async () => async () => {})
    const commit = vi.fn(async () => {})
    const app = application(rewindPort({ restore, commit }), undefined, undefined, undefined, {
      attachments: {
        readImage: vi.fn(async () => ({
          ref,
          data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
        })),
      },
    })
    const internals = app
    internals.session.rewind = vi.fn(async () => 'forked' as never)

    await internals.rewindProcess.perform(rewindPlan([ref]))

    expect(restore).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(expect.anything(), 'code-and-conversation', 'forked')
    expect(internals.composer.editor.getExpandedText()).toBe('inspect [Image #1]')
    expect(internals.composer.current.attachments).toEqual([expect.objectContaining({
      name: 'image.png',
      source: 'rewind',
    })])
  })

  it('does not mutate workspace or conversation when a Rewind image cannot be prepared', async () => {
    const ref: ImageAttachmentRef = {
      attachmentId: 'missing' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
    }
    const restore = vi.fn(async () => async () => {})
    const app = application(rewindPort({ restore }), undefined, undefined, undefined, {
      attachments: { readImage: vi.fn(async () => { throw new Error('missing attachment') }) },
    })
    const internals = app
    const rewind = vi.fn(async () => 'forked' as never)
    internals.session.rewind = rewind

    await internals.rewindProcess.perform(rewindPlan([ref]))

    expect(restore).not.toHaveBeenCalled()
    expect(rewind).not.toHaveBeenCalled()
    expect(internals.composer.current.attachments).toEqual([])
  })

  it('restores code only without reading attachments or replacing the Composer', async () => {
    const ref: ImageAttachmentRef = {
      attachmentId: 'missing' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
    }
    const commit = vi.fn(async () => {})
    const app = application(rewindPort({ commit }), undefined, undefined, undefined, {
      attachments: { readImage: vi.fn(async () => { throw new Error('must not be read') }) },
    })
    const internals = app
    internals.composer.editor.setText('keep this draft')
    const conversation = vi.fn(async () => 'forked' as never)
    internals.session.rewind = conversation

    await internals.rewindProcess.perform(rewindPlan([ref]), 'code-only')

    expect(conversation).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledWith(expect.anything(), 'code-only', undefined)
    expect(internals.composer.editor.getExpandedText()).toBe('keep this draft')
  })

  it('waits for an in-flight Rewind transaction before application disposal completes', async () => {
    let releaseRestore!: () => void
    const restore = vi.fn(async () => {
      await new Promise<void>(resolve => { releaseRestore = resolve })
      return async () => {}
    })
    const app = application(rewindPort({ restore }))

    const operation = app.rewindProcess.perform(rewindPlan(), 'code-only')
    await vi.waitFor(() => { expect(restore).toHaveBeenCalledOnce() })
    let disposed = false
    const disposal = app.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    releaseRestore()
    await Promise.all([operation, disposal])
    expect(disposed).toBe(true)
  })

  it('queues with Tab while working and leaves Alt+Enter for multiline input', () => {
    const app = application()
    const internals = app
    const submit = vi.fn(async () => {})
    internals.session.prompt = submit
    const idleState = internals.session.current
    vi.spyOn(internals.session, 'current', 'get').mockReturnValue({
      ...idleState,
      runState: 'running',
    })
    internals.composer.editor.setText('next task')

    expect(sendInput(internals, '\u001b\r')).toBeUndefined()
    expect(sendInput(internals, '\t')).toEqual({ consume: true })
    expect(submit).toHaveBeenCalledWith('next task', 'queue')
  })

  it('keeps model and workspace identity on the first footer row and metrics on the second', () => {
    const gitBranch = vi.fn((_cwd: string, onChange: (branch: string | undefined) => void) => {
      onChange('feature/footer-context')
      return () => {}
    })
    const app = application(undefined, undefined, undefined, undefined, { gitBranch })
    const internals = app

    app.render({
      ...internals.session.current,
      runState: 'running',
      modelCatalog: {
        default: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
        routableProviders: ['deepseek-official'],
        groups: [],
        failures: [],
      },
      projections: {
        sessionStats: {
          turns: 2,
          steps: 3,
          llmMs: 3_800,
          toolMs: 1_200,
          ttftMs: 1_600,
          ttftSteps: 2,
          decodeMs: 2_500,
          decodeTokens: 50,
        },
        tokenUsage: {
          uncachedInputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 900,
          cacheWriteTokens: 0,
        },
        contextPressure: {
          projectedTokens: 45_000,
          pressureTokens: 40_000,
          contextWindow: 100_000,
        },
      },
    })

    const footer = internals.footer.render(240).map(line => line.trimEnd())
    expect(gitBranch).toHaveBeenCalledWith('/workspace', expect.any(Function))
    expect(footer[0]).toContain('deepseek-official/deepseek-v4-pro · max')
    expect(footer[0]).toContain('workspace · feature/footer-context')
    expect(footer).toHaveLength(2)
    expect(footer.slice(1).join('\n')).toContain('2 turns · 3 steps')
    expect(footer.join('\n')).not.toMatch(/queue|newline|image|details|\/help/u)
  })

  it('adds ordinary Enter submissions to up/down editor history', () => {
    const app = application()
    const internals = app
    const submit = vi.fn(async () => {})
    internals.session.prompt = submit

    internals.composer.editor.setText('first prompt')
    internals.composer.editor.handleInput('\r')
    expect(submit).toHaveBeenCalledWith('first prompt', 'queue')

    internals.composer.editor.handleInput('\u001b[A')
    expect(internals.composer.editor.getExpandedText()).toBe('first prompt')
    internals.composer.editor.handleInput('\u001b[B')
    expect(internals.composer.editor.getExpandedText()).toBe('')
  })

  it.each([
    ['Escape', '\u001b'],
    ['Ctrl+C', '\u0003'],
  ])('%s interrupts an approval turn without manufacturing a rejection', async (_label, input) => {
    const app = application()
    const internals = app
    const prompt = approvalPrompt()
    const cancel = vi.fn(async () => {})
    const answerApproval = vi.fn(async () => {})
    internals.session.cancel = cancel
    internals.session.answerApproval = answerApproval

    internals.interactions.requestApproval(prompt)
    expect(internals.surfaces.active).toBe(true)

    expect(sendInput(internals, input)).toEqual({ consume: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect(answerApproval).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(internals.surfaces.active).toBe(false) })
  })

  it('exits on repeated Ctrl+C when approval cancellation does not settle', async () => {
    const exit = vi.fn()
    const app = application(undefined, undefined, { exit })
    const internals = app
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    internals.session.cancel = cancel

    internals.interactions.requestApproval(approvalPrompt())
    expect(sendInput(internals, '\u0003')).toEqual({ consume: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()

    expect(sendInput(internals, '\u0003')).toEqual({ consume: true })
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
  })

  it('keeps explicit approval rejection separate from turn interruption', async () => {
    const app = application()
    const internals = app
    const prompt = approvalPrompt()
    const cancel = vi.fn(async () => {})
    const answerApproval = vi.fn(async () => {})
    internals.session.cancel = cancel
    internals.session.answerApproval = answerApproval

    internals.interactions.requestApproval(prompt)
    expect(sendInput(internals, '\u001b[B')).toEqual({ consume: true })
    expect(sendInput(internals, '\r')).toEqual({ consume: true })

    await vi.waitFor(() => {
      expect(answerApproval).toHaveBeenCalledWith(prompt, 'rejected')
      expect(internals.surfaces.active).toBe(false)
    })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('counts physical Escape presses without treating release or repeat as the second press', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app
    const requestRewind = vi.fn()
    internals.rewindProcess.request = requestRewind

    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(requestRewind).not.toHaveBeenCalled()
    expect(internals.session.current.notice).toBeUndefined()
    expect(sendInput(internals, '\u001b[27;1:2u')).toEqual({ consume: true })
    expect(sendInput(internals, '\u001b[27;1:3u')).toEqual({ consume: true })
    expect(requestRewind).not.toHaveBeenCalled()
    vi.setSystemTime(1_300)
    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(requestRewind).toHaveBeenCalledOnce()
  })

  it('clears an idle draft with Escape and restores it with Up or hides it with Down', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app
    internals.composer.editor.setText('unfinished prompt')

    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(internals.composer.editor.getExpandedText()).toBe('')
    expect(internals.status.render(100).join('\n')).toContain('↑ to restore draft')

    expect(sendInput(internals, '\u001b[A')).toEqual({ consume: true })
    expect(internals.composer.editor.getExpandedText()).toBe('unfinished prompt')
    expect(sendInput(internals, '\u001b[B')).toEqual({ consume: true })
    expect(internals.composer.editor.getExpandedText()).toBe('')
  })

  it('clears and restores text and images as one Composer draft', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => clipboardPng(),
    })
    const internals = app
    await internals.composer.pasteImage()
    const attachment = internals.composer.current.attachments[0]
    internals.composer.editor.handleInput('inspect this')

    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(internals.composer.editor.getExpandedText()).toBe('')
    expect(internals.composer.current.attachments).toEqual([])
    expect(internals.composer.editorFrame.render(80).join('\n')).not.toContain('[Image #1]')

    expect(sendInput(internals, '\u001b[A')).toEqual({ consume: true })
    expect(internals.composer.editor.getExpandedText()).toBe('[Image #1] inspect this')
    expect(internals.composer.current.attachments).toEqual([attachment])
    expect(internals.composer.editorFrame.render(80).join('\n')).toContain('[Image #1]')

    expect(sendInput(internals, '\u001b[B')).toEqual({ consume: true })
    expect(internals.composer.editor.getExpandedText()).toBe('')
    expect(internals.composer.current.attachments).toEqual([])
  })

  it('lets the editor dismiss autocomplete before Escape clears the draft', () => {
    const app = application()
    const internals = app
    internals.composer.editor.setText('/rew')
    vi.spyOn(internals.composer.editor, 'isShowingAutocomplete').mockReturnValue(true)

    expect(sendInput(internals, '\u001b')).toBeUndefined()
    expect(internals.composer.editor.getExpandedText()).toBe('/rew')
  })

  it('keeps the running animation in the fixed status row above the editor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app
    const running = {
      ...internals.session.current,
      connection: { events: 'online', control: 'online' },
      runState: 'running',
      pendingSubmissions: [{
        key: 1,
        text: 'start work',
        mode: 'queue',
        intent: 'working',
      }],
    } satisfies RuntimeSessionSnapshot
    app.render(running)

    expect(internals.status.render(80).join('\n')).toContain('Working (0s · esc to interrupt)')
    expect(internals.transcript.render(80).join('\n')).not.toContain('Working')
    const footer = internals.footer.render(80).join('\n')
    expect(footer).toContain('model unavailable')
    expect(footer).not.toMatch(/queue|newline|image|details|\/help/u)

    vi.setSystemTime(5_000)
    app.render({
      ...running,
      pendingSubmissions: [],
      events: [{
        event: {
          type: 'tool/result',
          seq: 1,
          time: 2,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'tool-result-wait',
              role: 'user',
              source: { kind: 'tool', callId: 'call-wait' },
              content: [{
                type: 'tool-result',
                toolCallId: 'call-wait',
                content: [{ type: 'text', text: 'done' }],
              }],
            },
          },
        },
      }] as unknown as RuntimeSessionSnapshot['events'],
    })
    expect(internals.status.render(80).join('\n')).toContain('Working (4s · esc to interrupt)')
    expect(internals.transcript.render(80).join('\n')).not.toContain('Working')
  })

  it('spins the status bar while a Host command like /compact executes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let resolveExecute: ((result: HostCommandResult) => void) | undefined
    const source: HostCommandSource = {
      list: sessionId => sessionId === undefined ? [] : [{
        name: 'compact',
        description: 'Compact the conversation',
      }],
      execute: () => new Promise(resolve => { resolveExecute = resolve }),
      subscribe: () => () => {},
    }
    const app = application(undefined, undefined, undefined, source)
    const internals = app
    const state = {
      ...internals.session.current,
      sessionId: 'session-command' as RuntimeSessionSnapshot['sessionId'],
      connection: { events: 'online', control: 'online' },
    } satisfies RuntimeSessionSnapshot
    vi.spyOn(internals.session, 'current', 'get').mockReturnValue(state)
    app.render(state)

    const pending = internals.composer.submit('/compact')
    await vi.waitFor(() => {
      expect(stripTerminalSequences(internals.status.render(80).join('\n'))).toContain('Running /compact (0s)')
    })
    vi.advanceTimersByTime(160)
    expect(stripTerminalSequences(internals.status.render(80).join('\n'))).toContain('✢ Running /compact')
    vi.advanceTimersByTime(160)
    expect(stripTerminalSequences(internals.status.render(80).join('\n'))).toContain('✳ Running /compact')

    resolveExecute?.({ kind: 'success' })
    await pending
    expect(stripTerminalSequences(internals.status.render(80).join('\n'))).toContain('Ready')
  })

  it('keeps local commands out of the Host command working wait', async () => {
    const app = application()
    const internals = app
    const state = { ...internals.session.current, connection: { events: 'online', control: 'online' } } satisfies RuntimeSessionSnapshot
    vi.spyOn(internals.session, 'current', 'get').mockReturnValue(state)
    vi.spyOn(internals.session, 'notice').mockImplementation(() => {})
    app.render(state)

    await internals.composer.submit('/help')
    const status = stripTerminalSequences(internals.status.render(80).join('\n'))
    expect(status).toContain('Ready')
    expect(status).not.toContain('Running')
  })

  it('restarts fallback elapsed time for each optimistic activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app
    const base = internals.session.current

    app.render({
      ...base,
      pendingSubmissions: [{
        key: 1,
        text: 'first task',
        mode: 'queue',
        intent: 'working',
      }],
    })
    vi.setSystemTime(5_000)
    app.render({
      ...base,
      pendingSubmissions: [{
        key: 2,
        text: 'second task',
        mode: 'queue',
        intent: 'working',
      }],
    })

    expect(internals.status.render(80).join('\n')).toContain('Working (0s · esc to interrupt)')
    app.dispose()
  })

  it('uses a Vision-specific status while an image prompt is being prepared', () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000)
    const app = application()
    const internals = app

    const pendingSubmissions: RuntimeSessionSnapshot['pendingSubmissions'] = [{
      key: 1,
      text: 'analyze this image',
      mode: 'queue',
      intent: 'working',
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 1, startedAt: 1_000 },
    }]
    const preparing = {
      ...internals.session.current,
      connection: { events: 'online', control: 'online' },
      pendingSubmissions,
      execution: buildExecutionSnapshot({
        sessionId: undefined,
        epoch: 0,
        entries: [],
        sessionRunning: false,
        runtimeActivities: [{ kind: 'vision', analysisId: 'analysis-1', startedAt: 1_000 }],
      }),
    } satisfies RuntimeSessionSnapshot
    app.render(preparing)

    const status = internals.status.render(80).join('\n')
    expect(status).toContain('Vision · Analyzing 1 image (2s · esc to interrupt)')
    expect(status).not.toContain(' Working')
    app.dispose()
  })

  it('shows compact Host task projections in the fixed ready status', () => {
    const app = application()
    const internals = app
    app.render({
      ...internals.session.current,
      connection: { events: 'online', control: 'online' },
      projections: {
        permissions: {
          currentValue: 'workspace-write',
          options: [{ value: 'workspace-write', name: 'Workspace write' }],
        },
        plan: { active: true, pending: false },
        todos: [{ content: 'Implement', status: 'in_progress' }],
      },
    } as RuntimeSessionSnapshot)

    expect(internals.status.render(80).join('\n')).toContain(
      'Ready · workspace-write · Plan active',
    )
    expect(internals.status.render(80).join('\n')).not.toContain('Tasks 0/1')
  })

  it('shows the previous turn duration alongside the ready status', () => {
    const app = application()
    const internals = app
    app.render({
      ...internals.session.current,
      connection: { events: 'online', control: 'online' },
      execution: buildExecutionSnapshot({
        sessionId: undefined,
        epoch: 0,
        entries: [
          { event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } },
          { event: { type: 'turn/end', seq: 1, time: 9_400, data: { turn: 1, reason: { kind: 'completed' } } } },
        ] as unknown as HistoryEntry[],
        sessionRunning: false,
      }),
    } as RuntimeSessionSnapshot)

    expect(internals.status.render(80).join('\n')).toContain('Ready · last 9.4s')
    app.dispose()
  })

  it('carries only the Goal and Tasks segments down to the footer identity row', () => {
    const app = application()
    const internals = app
    app.render({
      ...internals.session.current,
      connection: { events: 'online', control: 'online' },
      projections: {
        permissions: {
          currentValue: 'workspace-write',
          options: [{ value: 'workspace-write', name: 'Workspace write' }],
        },
        plan: { active: true, pending: false },
        goal: {
          goal: {
            id: 'goal-1' as never,
            revision: 1,
            objective: 'Ship the TUI',
            phase: 'active',
            maxGoalRounds: 8,
          },
          roundsStarted: 2,
          createdAt: 1,
          updatedAt: 2,
        },
        todos: [{ content: 'Implement', status: 'in_progress' }],
      },
    } as RuntimeSessionSnapshot)

    const footer = internals.footer.render(200).join('\n')
    expect(footer).toContain('Goal active 2/8 · Tasks 0/1')
    expect(footer).not.toContain('workspace-write')
    expect(footer).not.toContain('Plan active')
  })

  it('opens /trajectory in the current TUI and returns to the composer on Escape', async () => {
    const app = application()
    const internals = app

    await internals.composer.submit('/trajectory')

    expect(internals.surfaces.active).toBe(true)
    expect(internals.trajectory.activeView?.render(80).join('\n')).toContain('Trajectory')
    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(internals.trajectory.activeView).toBeUndefined()
    expect(internals.surfaces.active).toBe(false)
  })

  it('restores the active composer surface after an approval is resolved', async () => {
    const app = application()
    const internals = app
    const prompt = approvalPrompt()

    await internals.composer.submit('/trajectory')
    const trajectory = internals.tui.getFocusedComponent()
    internals.interactions.requestApproval(prompt)

    expect(internals.tui.getFocusedComponent()).not.toBe(trajectory)
    expect(internals.layout.render(80).map(stripTerminalSequences).join('\n'))
      .toContain('╭─ Permission required · shell ─')

    internals.interactions.resolve(approvalResolution(prompt, 'cancelled'))
    expect(internals.surfaces.active).toBe(true)
    expect(internals.tui.getFocusedComponent()).toBe(trajectory)
    expect(internals.layout.render(80).map(stripTerminalSequences).join('\n')).toContain('Trajectory')

    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
  })

  it('opens Config, Task, and Skill discovery as separate composer-anchored surfaces', async () => {
    const app = application()
    const internals = app

    await internals.composer.submit('/config')
    expect(internals.configuration.activeConfigView?.render(80).join('\n')).toContain('Config')
    expect(internals.configuration.activeConfigView?.render(80).join('\n')).not.toContain('Goal')
    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(internals.configuration.activeConfigView).toBeUndefined()

    await internals.composer.submit('/task')
    expect(internals.taskProcess.activeView?.render(80).join('\n')).toContain('Task')
    expect(internals.taskProcess.activeView?.render(80).join('\n')).not.toContain('Permission')
    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(internals.taskProcess.activeView).toBeUndefined()

    await internals.composer.submit('/skills')
    expect(internals.skills.activeView?.render(80).join('\n')).toContain('Skills')
    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(internals.skills.activeView).toBeUndefined()

  })

  it('opens Web provider status without exposing credential values', async () => {
    const status = vi.fn(async () => ({
      search: {
        selection: 'auto' as const,
        activeProviderId: 'deepseek-official',
        providers: [{
          id: 'community-tavily',
          label: 'Tavily',
          description: 'Search through Tavily.',
          endpointHost: 'api.tavily.com',
          credentialRef: 'TAVILY_API_KEY',
          credentialConfigured: false,
          credentialWritable: true,
          available: false,
        }, {
          id: 'deepseek-official',
          label: 'DeepSeek Official',
          description: 'Use DeepSeek native web search.',
          endpointHost: 'api.deepseek.com',
          credentialRef: 'DEEPSEEK_API_KEY',
          credentialConfigured: true,
          credentialWritable: true,
          available: true,
        }],
      },
      extract: {
        activeProviderId: 'community-tavily',
        providers: [{
          id: 'community-tavily',
          label: 'Tavily',
          description: 'Read pages through Tavily.',
          endpointHost: 'api.tavily.com',
          credentialRef: 'TAVILY_API_KEY',
          credentialConfigured: false,
          credentialWritable: true,
          available: false,
        }],
      },
    }))
    const setSearchProvider = vi.fn(async () => {})
    const app = application(undefined, undefined, undefined, undefined, {
      web: { status, setSearchProvider },
    })
    const internals = app

    await internals.composer.submit('/config web')

    const output = internals.configuration.activeWebView?.render(100).join('\n') ?? ''
    expect(status).toHaveBeenCalledOnce()
    expect(output).toContain('DeepSeek Official')
    expect(output).toContain('TAVILY_API_KEY missing')
    expect(output).not.toContain('must-not-appear')
    expect(sendInput(internals, 'G')).toEqual({ consume: true })
    expect(sendInput(internals, '\r')).toEqual({ consume: true })
    await vi.waitFor(() => { expect(setSearchProvider).toHaveBeenCalledWith('deepseek-official') })
    expect(sendInput(internals, '\u001b')).toEqual({ consume: true })
    expect(internals.configuration.activeWebView).toBeUndefined()
  })

  it('opens bare /permission as a picker and executes selections outside model input', async () => {
    const execute = vi.fn(async () => ({ kind: 'success' as const, text: 'preset read-only' }))
    const setDefaultPreset = vi.fn(async () => {})
    const source: HostCommandSource = {
      list: sessionId => sessionId === undefined ? [] : [{
        name: 'permission',
        description: 'Switch permission',
        argumentHint: '<preset>',
      }, {
        name: 'compact',
        description: 'Compact context',
      }, {
        name: 'plan',
        description: 'Enter or leave Plan Mode',
      }],
      execute,
      subscribe: () => () => {},
    }
    const app = application(undefined, undefined, undefined, source, {
      permissionDefault: { setDefaultPreset },
    })
    const internals = app
    const state = {
      ...internals.session.current,
      sessionId: 'session-permission' as RuntimeSessionSnapshot['sessionId'],
      projections: {
        permissions: {
          currentValue: 'workspace-write',
          options: [{ value: 'workspace-write', name: 'Workspace write' }, {
            value: 'read-only',
            name: 'Read only',
          }],
        },
        plan: { active: false, pending: false },
      },
    } as RuntimeSessionSnapshot
    vi.spyOn(internals.session, 'current', 'get').mockReturnValue(state)
    const prompt = vi.spyOn(internals.session, 'prompt').mockResolvedValue()
    app.render(state)

    await internals.composer.submit('/permission')
    expect(internals.configuration.activeConfigView?.render(80).join('\n')).toContain('Permission')
    expect(execute).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()

    expect(sendInput(internals, 'j')).toEqual({ consume: true })
    expect(sendInput(internals, '\r')).toEqual({ consume: true })
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledWith(
        state.sessionId,
        '/permission read-only',
        expect.any(AbortSignal),
      )
      expect(setDefaultPreset).toHaveBeenCalledWith('read-only')
    })
    expect(internals.configuration.activeConfigView).toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()

    await internals.composer.submit('/compact')
    expect(execute).toHaveBeenCalledWith(state.sessionId, '/compact', expect.any(AbortSignal))
    expect(setDefaultPreset).toHaveBeenCalledTimes(1)
    expect(prompt).not.toHaveBeenCalled()

    await internals.composer.submit('/config permission')
    expect(sendInput(internals, 'j')).toEqual({ consume: true })
    expect(sendInput(internals, '\r')).toEqual({ consume: true })
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledWith(
        state.sessionId,
        '/permission read-only',
        expect.any(AbortSignal),
      )
      expect(setDefaultPreset).toHaveBeenCalledTimes(2)
    })
    expect(internals.configuration.activeConfigView).toBeUndefined()

    await internals.composer.submit('/permission workspace-write')
    expect(execute).toHaveBeenCalledWith(
      state.sessionId,
      '/permission workspace-write',
      expect.any(AbortSignal),
    )
    expect(setDefaultPreset).toHaveBeenLastCalledWith('workspace-write')

    await internals.composer.submit('/config plan')
    expect(sendInput(internals, '\r')).toEqual({ consume: true })
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(5)
      expect(execute).toHaveBeenCalledWith(state.sessionId, '/plan', expect.any(AbortSignal))
    })
    expect(setDefaultPreset).toHaveBeenCalledTimes(3)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('reports when Permission changes but its new-session default cannot be saved', async () => {
    const execute = vi.fn(async () => ({ kind: 'success' as const }))
    const source: HostCommandSource = {
      list: sessionId => sessionId === undefined ? [] : [{
        name: 'permission',
        description: 'Switch permission',
        argumentHint: '<preset>',
      }],
      execute,
      subscribe: () => () => {},
    }
    const app = application(undefined, undefined, undefined, source, {
      permissionDefault: {
        setDefaultPreset: vi.fn(async () => { throw new Error('settings are read-only') }),
      },
    })
    const internals = app
    const state = {
      ...internals.session.current,
      sessionId: 'session-permission-partial' as RuntimeSessionSnapshot['sessionId'],
    }
    vi.spyOn(internals.session, 'current', 'get').mockReturnValue(state)
    const notice = vi.spyOn(internals.session, 'notice')
    const prompt = vi.spyOn(internals.session, 'prompt').mockResolvedValue()
    app.render(state)

    await internals.composer.submit('/permission workspace-write')

    expect(execute).toHaveBeenCalledWith(
      state.sessionId,
      '/permission workspace-write',
      expect.any(AbortSignal),
    )
    expect(notice).toHaveBeenCalledWith(
      'Permission changed for this session, but its default could not be saved: settings are read-only',
    )
    expect(prompt).not.toHaveBeenCalled()
  })

  it('preserves exact Skill prompt text and rejects removed or unknown slash gestures', async () => {
    const app = application()
    const internals = app
    vi.spyOn(internals.session, 'current', 'get').mockReturnValue({
      ...internals.session.current,
      sessionId: 'session-skills' as RuntimeSessionSnapshot['sessionId'],
    })
    vi.spyOn(internals.skills, 'current', 'get').mockReturnValue({
      status: 'ready',
      entries: [{ name: 'review', description: 'Review changes', modelInvocable: true }],
    })
    vi.spyOn(internals.skills, 'refresh').mockResolvedValue([])
    const prompt = vi.spyOn(internals.session, 'prompt').mockResolvedValue()

    await internals.composer.submit('/review focus on races')
    await internals.composer.submit('/control')

    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith('/review focus on races', 'queue')
    expect(internals.composer.editor.getExpandedText()).toBe('/control')
  })

  it('submits a leading Unix absolute path as ordinary prompt text', async () => {
    const app = application()
    const internals = app
    const prompt = vi.spyOn(internals.session, 'prompt').mockResolvedValue()
    const text = '/Users/yinfinity/Workplace/project/README.md 在这个文件随便写一句话'

    await internals.composer.submit(text)

    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith(text, 'queue')
    expect(internals.composer.editor.getExpandedText()).toBe('')
  })

})
