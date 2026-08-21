import {
  Editor,
  stripTerminalSequences,
  type Terminal,
} from '@earendil-works/pi-tui'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HistoryEntry, IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TuiApplication,
  type TuiApplicationDependencies,
  type TuiMemoryPort,
  type TuiRuntime,
} from '../../src/application/app.ts'
import type { RewindAction, RewindPlan, RewindPort } from '../../src/rewind/index.ts'
import { resolveConfig } from '../../src/application/config.ts'
import type { TuiState } from '../../src/runtime/controller.ts'
import type { HostCommandSource, HostCommandResult } from '../../src/runtime/commands.ts'
import {
  memoryKeymapGateway,
  type KeymapSettingsGateway,
} from '../../src/application/keymap-settings.ts'
import type { VisionGateway } from '../../src/application/attachments/coordinator.ts'
import type { NewAttachmentDraft } from '../../src/application/attachments/drafts.ts'
import type { AttachmentDraft } from '../../src/application/attachments/drafts.ts'
import { buildLifecycleSnapshot } from '../../src/runtime/lifecycle/index.ts'
import type {
  ApprovalPrompt,
  InteractionResolution,
} from '../../src/runtime/controller.ts'

interface AppInternals {
  controller: {
    current: Readonly<TuiState>
    prompt(text: string, mode: 'queue' | 'steer'): Promise<void>
    notice(message: string): void
    cancel(): Promise<void>
    answerApproval(prompt: ApprovalPrompt, outcome: 'allowed-once' | 'rejected'): Promise<void>
    rewind(plan: RewindPlan, onProgress?: (phase: 'forking' | 'reloading') => void): Promise<string>
  }
  skillCatalog: {
    current: {
      status: 'ready'
      entries: Array<{ name: string; description: string; modelInvocable: boolean }>
    }
    refresh(force?: boolean): Promise<readonly unknown[]>
  }
  editor: Editor
  attachmentDrafts: { snapshot: readonly AttachmentDraft[] }
  attachmentCoordinator: {
    submit(
      sessionId: string,
      selection: unknown,
      text: string,
      mode: 'queue' | 'steer',
      limits: unknown,
      send: unknown,
    ): Promise<'native' | 'proxy'>
  }
  composerEditor: { render(width: number): string[] }
  footer: { render(width: number): string[] }
  status: { render(width: number): string[] }
  transcript: {
    render(width: number): string[]
    handlePointer(line: number, action: 'move' | 'click' | 'wheel-up' | 'wheel-down'): boolean
    isTrailingBlock(line: number): boolean
  }
  layout: {
    render(width: number): string[]
    transcriptRowAt(screenRow: number, viewportTop: number): number
    preserveTranscriptViewport(): void
    scrollTranscript(delta: number): boolean
  }
  trajectoryView?: { handleInput(data: string): void; render(width: number): string[] }
  configView?: { handleInput(data: string): void; render(width: number): string[] }
  webConfigView?: { handleInput(data: string): void; render(width: number): string[] }
  keymapView?: { handleInput(data: string): void; render(width: number): string[] }
  taskView?: { handleInput(data: string): void; render(width: number): string[] }
  skillsView?: { handleInput(data: string): void; render(width: number): string[] }
  composerModalActive: boolean
  tui: {
    requestRender(): void
    hasOverlay(): boolean
    getFocusedComponent(): { handleInput?(data: string): void } | null
    beginTextSelection(x: number, y: number): boolean
    updateTextSelection(x: number, y: number): boolean
    finishTextSelection(x: number, y: number):
      | { kind: 'none'; changed: false }
      | { kind: 'click'; changed: boolean }
      | { kind: 'selection'; changed: boolean; text: string }
  }
  handleGlobalInput(data: string): { consume?: boolean } | undefined
  requestApproval(prompt: ApprovalPrompt): void
  resolveInteraction(resolution: InteractionResolution): void
  pasteImage(): Promise<void>
  requestRewind(): void
  performRewind(plan: RewindPlan, action?: RewindAction): Promise<void>
  requestExit(code: number): Promise<void>
  submit(value: string, forcedMode?: 'queue' | 'steer'): Promise<void>
}

function memoryService(overrides: Partial<TuiMemoryPort> = {}): TuiMemoryPort {
  return {
    onActivity: () => () => {},
    overview: async () => { throw new Error('no test Memory overview') },
    setPolicy: () => { throw new Error('no test Memory policy') },
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
    input: { text: 'inspect image', attachments },
    createdAt: 1,
    codeScope: 'backward',
    state: 'safe',
    files: [],
    participants: [],
  }
}

function approvalPrompt(): ApprovalPrompt {
  return {
    type: 'approval/requested',
    sessionId: 'session-1',
    approvalId: 'approval-1',
    rpcId: 'rpc-approval-1',
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
    approvalId: prompt.approvalId,
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

function application(
  rewind: RewindPort = rewindPort(),
  memory: TuiMemoryPort = memoryService(),
  runtimeOverrides: Partial<TuiRuntime> = {},
  commandSource?: HostCommandSource,
  keymap?: KeymapSettingsGateway,
  dependencies: TuiApplicationDependencies = {},
): TuiApplication {
  const runtime: TuiRuntime = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: vi.fn(),
    ...runtimeOverrides,
  }
  const app = new TuiApplication(
    {} as IApiClient,
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
      ...keymap === undefined ? {} : { keymap },
    },
  )
  ;(app as unknown as AppInternals).tui.requestRender = vi.fn()
  return app
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

describe('TuiApplication input routing', () => {
  it('clears an idle draft before Ctrl+C exits an empty composer', async () => {
    const exit = vi.fn()
    const app = application(undefined, undefined, { exit })
    const internals = app as unknown as AppInternals
    internals.editor.setText('unfinished prompt')

    expect(internals.handleGlobalInput('\u0003')).toEqual({ consume: true })
    expect(internals.editor.getExpandedText()).toBe('')
    expect(internals.status.render(100).join('\n')).toContain('Input cleared · ↑ to restore')
    expect(exit).not.toHaveBeenCalled()

    expect(internals.handleGlobalInput('\u0003')).toEqual({ consume: true })
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
  })

  it('Ctrl+C clears a draft while working instead of interrupting', () => {
    const exit = vi.fn()
    const app = application(undefined, undefined, { exit })
    const internals = app as unknown as AppInternals
    const cancel = vi.fn(async () => {})
    internals.controller.cancel = cancel
    const idleState = internals.controller.current
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue({
      ...idleState,
      running: true,
      lifecycle: buildLifecycleSnapshot({
        sessionId: undefined,
        generation: 1,
        entries: [],
        sessionRunning: true,
      }),
    })
    internals.editor.setText('queued thought')

    expect(internals.handleGlobalInput('\u0003')).toEqual({ consume: true })
    expect(internals.editor.getExpandedText()).toBe('')
    expect(cancel).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()

    expect(internals.handleGlobalInput('\u0003')).toEqual({ consume: true })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('exits on repeated Ctrl+C when an interrupted runtime never becomes idle', async () => {
    const exit = vi.fn()
    const write = vi.fn(() => true)
    const app = application(undefined, undefined, {
      exit,
      stdout: { write } as unknown as NodeJS.WriteStream,
    })
    const internals = app as unknown as AppInternals
    const current = internals.controller.current
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue({
      ...current,
      sessionId: 'session-stuck' as TuiState['sessionId'],
      running: true,
      lifecycle: buildLifecycleSnapshot({
        sessionId: 'session-stuck',
        generation: 1,
        entries: [],
        sessionRunning: true,
      }),
    })
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    internals.controller.cancel = cancel

    expect(internals.handleGlobalInput('\u0003')).toEqual({ consume: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    expect(internals.status.render(100).join('\n')).toContain('Ctrl+C again to exit')

    expect(internals.handleGlobalInput('\u0003')).toEqual({ consume: true })
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
      controller: {
        sessions(): Promise<Array<{ sessionId: string; blank: boolean }>>
        start(sessionId?: string): Promise<void>
      }
      commands: { dispatchHost(command: string): Promise<void> }
      submit(prompt: string): Promise<void>
    }
    internals.controller.sessions = vi.fn(async () => [
      { sessionId: 'blank', blank: true },
      { sessionId: 'latest-subagent', blank: false, origin: 'subagent' },
      { sessionId: 'latest-conversation', blank: false },
    ])
    internals.controller.start = vi.fn(async (sessionId) => { events.push(`start:${sessionId ?? ''}`) })
    internals.commands.dispatchHost = vi.fn(async command => { events.push(command) })
    internals.submit = vi.fn(async prompt => { events.push(`prompt:${prompt}`) })

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

  it('opens and applies workspace file suggestions for @ input', async () => {
    const workspacePaths = vi.fn(async () => [
      { path: 'README.md', isDirectory: false },
      { path: 'src/read-model.ts', isDirectory: false },
    ])
    const app = application(undefined, undefined, undefined, undefined, undefined, { workspacePaths })
    const internals = app as unknown as AppInternals

    for (const character of '@rea') internals.editor.handleInput(character)
    const before = internals.layout.render(80).map(stripTerminalSequences)
    const inputRow = before.findIndex(line => line.includes('@rea'))

    await vi.waitFor(() => { expect(internals.editor.isShowingAutocomplete()).toBe(true) })
    const after = internals.layout.render(80).map(stripTerminalSequences)
    const suggestionRow = after.findIndex(line => line.includes('README.md'))
    const inputRowWithSuggestions = after.findIndex(line => line.includes('@rea'))

    expect(inputRow).toBeGreaterThanOrEqual(0)
    expect(inputRowWithSuggestions).toBe(inputRow)
    expect(suggestionRow).toBeGreaterThanOrEqual(0)
    expect(suggestionRow).toBeLessThan(inputRowWithSuggestions)

    internals.editor.handleInput('\r')
    expect(internals.editor.getText()).toBe('@README.md ')
    expect(workspacePaths).toHaveBeenCalledWith('/workspace', expect.any(AbortSignal))
  })

  it('keeps slash suggestions above the same bottom-anchored input row', async () => {
    const app = application()
    const internals = app as unknown as AppInternals

    for (const character of '/he') internals.editor.handleInput(character)
    const before = internals.layout.render(80).map(stripTerminalSequences)
    const inputRow = before.findIndex(line => line.includes('/he'))

    await vi.waitFor(() => { expect(internals.editor.isShowingAutocomplete()).toBe(true) })
    const after = internals.layout.render(80).map(stripTerminalSequences)
    const suggestionRow = after.findIndex(line => line.includes('help'))
    const inputRowWithSuggestions = after.findIndex(line => line.includes('/he'))

    expect(inputRow).toBeGreaterThanOrEqual(0)
    expect(inputRowWithSuggestions).toBe(inputRow)
    expect(suggestionRow).toBeGreaterThanOrEqual(0)
    expect(suggestionRow).toBeLessThan(inputRowWithSuggestions)
  })

  it('copies a dragged primary-button selection without dispatching a block click', async () => {
    const clipboardText = vi.fn(async () => {})
    const app = application(undefined, undefined, undefined, undefined, undefined, { clipboardText })
    const internals = app as unknown as AppInternals
    internals.layout.transcriptRowAt = vi.fn(() => 0)
    internals.transcript.handlePointer = vi.fn(() => false)
    internals.tui.beginTextSelection = vi.fn(() => true)
    internals.tui.updateTextSelection = vi.fn(() => true)
    internals.tui.finishTextSelection = vi.fn(() => ({
      kind: 'selection' as const,
      changed: false,
      text: 'selected output',
    }))

    expect(internals.handleGlobalInput('\u001b[<0;1;1M')).toEqual({ consume: true })
    expect(internals.handleGlobalInput('\u001b[<32;8;1M')).toEqual({ consume: true })
    expect(internals.handleGlobalInput('\u001b[<0;8;1m')).toEqual({ consume: true })
    await vi.waitFor(() => { expect(clipboardText).toHaveBeenCalledWith('selected output') })

    expect(internals.transcript.handlePointer).not.toHaveBeenCalledWith(0, 'click')
  })

  it('dispatches a title click only after a primary-button gesture ends without selection', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    internals.layout.transcriptRowAt = vi.fn(() => 0)
    const handlePointer = vi.fn(() => true)
    internals.transcript.handlePointer = handlePointer
    internals.transcript.isTrailingBlock = vi.fn(() => false)
    internals.layout.preserveTranscriptViewport = vi.fn()
    internals.tui.beginTextSelection = vi.fn(() => true)
    internals.tui.finishTextSelection = vi.fn(() => ({ kind: 'click' as const, changed: false }))

    internals.handleGlobalInput('\u001b[<0;1;1M')
    expect(handlePointer).not.toHaveBeenCalledWith(0, 'click')
    expect(internals.layout.preserveTranscriptViewport).not.toHaveBeenCalled()

    internals.handleGlobalInput('\u001b[<0;1;1m')
    expect(handlePointer).toHaveBeenCalledWith(0, 'click')
    expect(internals.layout.preserveTranscriptViewport).toHaveBeenCalledOnce()
  })

  it('keeps tail following when the clicked disclosure block reaches the transcript end', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    internals.layout.transcriptRowAt = vi.fn(() => 0)
    const handlePointer = vi.fn(() => true)
    internals.transcript.handlePointer = handlePointer
    internals.transcript.isTrailingBlock = vi.fn(() => true)
    internals.layout.preserveTranscriptViewport = vi.fn()
    internals.tui.beginTextSelection = vi.fn(() => true)
    internals.tui.finishTextSelection = vi.fn(() => ({ kind: 'click' as const, changed: false }))

    internals.handleGlobalInput('\u001b[<0;1;1m')

    expect(handlePointer).toHaveBeenCalledWith(0, 'click')
    expect(internals.transcript.isTrailingBlock).toHaveBeenCalledWith(0)
    expect(internals.layout.preserveTranscriptViewport).not.toHaveBeenCalled()
  })

  it('renders hover only when the pointer enters or leaves a fold title', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    internals.layout.transcriptRowAt = vi.fn(() => 0)
    const handlePointer = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    internals.transcript.handlePointer = handlePointer
    const requestRender = vi.mocked(internals.tui.requestRender)

    internals.handleGlobalInput('\u001b[<35;1;1M')
    internals.handleGlobalInput('\u001b[<35;2;1M')
    internals.layout.transcriptRowAt = vi.fn(() => 4)
    internals.handleGlobalInput('\u001b[<35;2;5M')

    expect(handlePointer).toHaveBeenNthCalledWith(1, 0, 'move')
    expect(handlePointer).toHaveBeenNthCalledWith(2, 0, 'move')
    expect(handlePointer).toHaveBeenNthCalledWith(3, 4, 'move')
    expect(requestRender).toHaveBeenCalledTimes(2)
  })

  it('renders approval in the composer surface while keeping transcript wheel scrolling', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    const prompt = approvalPrompt()
    const scrollTranscript = vi.fn(() => true)
    internals.layout.scrollTranscript = scrollTranscript
    internals.transcript.handlePointer = vi.fn(() => false)

    internals.requestApproval(prompt)
    expect(internals.tui.hasOverlay()).toBe(false)
    expect(internals.composerModalActive).toBe(true)
    const approval = internals.layout.render(80)
      .map(line => stripTerminalSequences(line).trimEnd())
      .join('\n')
    expect(approval).toContain('╭─ Permission required · shell ─')
    expect(approval).toContain('Allow once')
    expect(approval).toContain('Reject and continue')
    expect(approval).toContain('╰─ ↑/↓ select · Enter confirm · Esc/Ctrl+C interrupt task ─')

    expect(internals.handleGlobalInput('\u001b[<64;8;9M')).toEqual({ consume: true })
    expect(scrollTranscript).toHaveBeenCalledWith(-1)
    expect(internals.transcript.handlePointer).not.toHaveBeenCalledWith(expect.any(Number), 'wheel-up')

    internals.resolveInteraction(approvalResolution(prompt, 'cancelled'))
    expect(internals.tui.hasOverlay()).toBe(false)
    expect(internals.composerModalActive).toBe(false)
    expect(internals.tui.getFocusedComponent()).toBe(internals.editor)
  })

  it('uses Ctrl+V as the primary image paste shortcut and keeps Alt+V compatible', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    const pasteImage = vi.fn(async () => {})
    internals.pasteImage = pasteImage

    expect(internals.handleGlobalInput('\u0016')).toEqual({ consume: true })
    expect(internals.handleGlobalInput('\u001bv')).toEqual({ consume: true })
    expect(pasteImage).toHaveBeenCalledTimes(2)
  })

  it('suppresses key repeat and release events before invoking image paste', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    const pasteImage = vi.fn(async () => {})
    internals.pasteImage = pasteImage

    expect(internals.handleGlobalInput('\u001b[118;5u')).toEqual({ consume: true })
    expect(internals.handleGlobalInput('\u001b[118;5:2u')).toEqual({ consume: true })
    expect(internals.handleGlobalInput('\u001b[118;5:3u')).toEqual({ consume: true })
    expect(pasteImage).toHaveBeenCalledOnce()
  })

  it('anchors one coalesced clipboard image at the invocation cursor before loading completes', async () => {
    let resolveClipboard!: (draft: NewAttachmentDraft) => void
    const clipboardImage = vi.fn(() => new Promise<NewAttachmentDraft>((resolve) => {
      resolveClipboard = resolve
    }))
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage,
    })
    const internals = app as unknown as AppInternals
    internals.editor.setText('beforeafter')
    for (let index = 0; index < 5; index += 1) internals.editor.handleInput('\u001b[D')

    const first = internals.pasteImage()
    const second = internals.pasteImage()
    expect(clipboardImage).toHaveBeenCalledOnce()
    expect(internals.editor.getExpandedText()).toBe('before [Image #1] after')
    resolveClipboard(clipboardPng())
    await Promise.all([first, second])

    expect(internals.attachmentDrafts.snapshot).toHaveLength(1)
    expect(internals.attachmentDrafts.snapshot[0]?.placeholder).toBe('[Image #1]')
    expect(internals.composerEditor.render(80).join('\n')).toContain('[Image #1]')
  })

  it('retains a Composer image created by the paste-image command', async () => {
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => clipboardPng(),
    })
    const internals = app as unknown as AppInternals

    await internals.submit('/paste-image')

    expect(internals.editor.getExpandedText()).toBe('[Image #1] ')
    expect(internals.attachmentDrafts.snapshot).toEqual([
      expect.objectContaining({ placeholder: '[Image #1]', name: 'clipboard.png' }),
    ])
  })

  it('treats an inline image reference as one editing unit', async () => {
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => clipboardPng(),
    })
    const internals = app as unknown as AppInternals
    await internals.pasteImage()

    internals.editor.handleInput('\u007F')
    expect(internals.editor.getExpandedText()).toBe('[Image #1]')
    internals.editor.handleInput('\u001b[D')
    expect(internals.editor.getCursor().col).toBe(0)
    internals.editor.handleInput('\u001b[C')
    expect(internals.editor.getCursor().col).toBe('[Image #1]'.length)
    internals.editor.handleInput('\u007F')
    expect(internals.editor.getExpandedText()).toBe('')
    expect(internals.attachmentDrafts.snapshot).toEqual([])

    internals.editor.handleInput('\u001F')
    expect(internals.editor.getExpandedText()).toBe('[Image #1]')
    expect(internals.attachmentDrafts.snapshot).toHaveLength(1)

    expect(internals.handleGlobalInput('\u001b\u007F')).toEqual({ consume: true })
    expect(internals.attachmentDrafts.snapshot).toEqual([])
    expect(internals.editor.getExpandedText()).toBe('')
    expect(internals.composerEditor.render(80).join('\n')).not.toContain('[Image #1]')

    internals.editor.handleInput('\u001F')
    expect(internals.editor.getExpandedText()).toBe('[Image #1]')
    expect(internals.attachmentDrafts.snapshot).toHaveLength(1)

    internals.editor.handleInput('\u0015')
    expect(internals.editor.getExpandedText()).toBe('')
    expect(internals.attachmentDrafts.snapshot).toEqual([])
    internals.editor.handleInput('\u001F')
    expect(internals.attachmentDrafts.snapshot).toHaveLength(1)
  })

  it('attaches images when the Editor submit callback delivers raw encoded references', async () => {
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => clipboardPng(),
    })
    const internals = app as unknown as AppInternals
    const base = internals.controller.current
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue({
      ...base,
      sessionId: 'session-attach' as never,
      models: {
        current: { provider: 'provider', model: 'model' },
        routable: true,
        groups: [],
        failures: [],
      },
    })
    const coordinatorSubmit = vi.fn<typeof internals.attachmentCoordinator.submit>(async () => 'native')
    internals.attachmentCoordinator.submit = coordinatorSubmit
    await internals.pasteImage()
    internals.editor.handleInput('what is this')

    // pi-tui submitValue() emits onChange('') before onSubmit with the raw stored lines,
    // whose inline references keep the encoded U+2800 separator.
    internals.editor.onChange?.('')
    expect(internals.attachmentDrafts.snapshot).toEqual([])
    internals.editor.onSubmit?.('[Image\u2800#1] what is this')

    await vi.waitFor(() => {
      expect(coordinatorSubmit).toHaveBeenCalledOnce()
    })
    expect(coordinatorSubmit).toHaveBeenCalledWith(
      'session-attach',
      { provider: 'provider', model: 'model' },
      '[Image #1] what is this',
      'queue',
      undefined,
      expect.anything(),
    )
    expect(internals.attachmentDrafts.snapshot).toEqual([
      expect.objectContaining({ placeholder: '[Image #1]' }),
    ])
  })

  it('removes session-scoped image tokens without dropping plain draft text on session switch', async () => {
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => clipboardPng(),
    })
    const internals = app as unknown as AppInternals
    app.render({ ...internals.controller.current, sessionId: 'first-session' as never })
    await internals.pasteImage()
    internals.editor.handleInput('keep this')

    app.render({ ...internals.controller.current, sessionId: 'next-session' as never })

    expect(internals.editor.getExpandedText()).toBe('keep this')
    expect(internals.attachmentDrafts.snapshot).toEqual([])
  })

  it('discards an in-flight clipboard reservation when its session changes', async () => {
    let resolveClipboard!: (draft: NewAttachmentDraft) => void
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: () => new Promise(resolve => { resolveClipboard = resolve }),
    })
    const internals = app as unknown as AppInternals
    app.render({ ...internals.controller.current, sessionId: 'first-session' as never })

    const paste = internals.pasteImage()
    expect(internals.editor.getExpandedText()).toBe('[Image #1] ')
    app.render({ ...internals.controller.current, sessionId: 'next-session' as never })
    resolveClipboard(clipboardPng())
    await paste

    expect(internals.editor.getExpandedText()).toBe('')
    expect(internals.attachmentDrafts.snapshot).toEqual([])
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
    const app = application(rewindPort({ restore, commit }), undefined, undefined, undefined, undefined, {
      attachments: {
        readImage: vi.fn(async () => ({
          ref,
          data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
        })),
      },
    })
    const internals = app as unknown as AppInternals
    internals.controller.rewind = vi.fn(async () => 'forked')

    await internals.performRewind(rewindPlan([ref]))

    expect(restore).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(expect.anything(), 'code-and-conversation', 'forked')
    expect(internals.editor.getExpandedText()).toBe('inspect image [Image #1]')
    expect(internals.attachmentDrafts.snapshot).toEqual([expect.objectContaining({
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
    const app = application(rewindPort({ restore }), undefined, undefined, undefined, undefined, {
      attachments: { readImage: vi.fn(async () => { throw new Error('missing attachment') }) },
    })
    const internals = app as unknown as AppInternals
    const rewind = vi.fn(async () => 'forked')
    internals.controller.rewind = rewind

    await internals.performRewind(rewindPlan([ref]))

    expect(restore).not.toHaveBeenCalled()
    expect(rewind).not.toHaveBeenCalled()
    expect(internals.attachmentDrafts.snapshot).toEqual([])
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
    const app = application(rewindPort({ commit }), undefined, undefined, undefined, undefined, {
      attachments: { readImage: vi.fn(async () => { throw new Error('must not be read') }) },
    })
    const internals = app as unknown as AppInternals
    internals.editor.setText('keep this draft')
    const conversation = vi.fn(async () => 'forked')
    internals.controller.rewind = conversation

    await internals.performRewind(rewindPlan([ref]), 'code-only')

    expect(conversation).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledWith(expect.anything(), 'code-only', undefined)
    expect(internals.editor.getExpandedText()).toBe('keep this draft')
  })

  it('queues with Tab while working and leaves Alt+Enter for multiline input', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    const submit = vi.fn(async () => {})
    internals.submit = submit
    const idleState = internals.controller.current
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue({
      ...idleState,
      running: true,
    })
    internals.editor.setText('next task')

    expect(internals.handleGlobalInput('\u001b\r')).toBeUndefined()
    expect(internals.handleGlobalInput('\t')).toEqual({ consume: true })
    expect(submit).toHaveBeenCalledWith('next task', 'queue')
  })

  it('keeps legacy Alt+Enter queueing configurable without consuming it while idle', () => {
    const keymap = memoryKeymapGateway({ keymap: 'legacy' })
    const app = application(undefined, undefined, undefined, undefined, keymap)
    const internals = app as unknown as AppInternals
    const submit = vi.fn(async () => {})
    internals.submit = submit
    const idleState = internals.controller.current

    expect(internals.handleGlobalInput('\u001b\r')).toBeUndefined()
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue({
      ...idleState,
      running: true,
    })
    internals.editor.setText('legacy task')
    expect(internals.handleGlobalInput('\u001b\r')).toEqual({ consume: true })
    expect(submit).toHaveBeenCalledWith('legacy task', 'queue')
  })

  it('keeps model and workspace identity on the first footer row and metrics on the second', () => {
    const gitBranch = vi.fn((_cwd: string, onChange: (branch: string | undefined) => void) => {
      onChange('feature/footer-context')
      return () => {}
    })
    const app = application(undefined, undefined, undefined, undefined, undefined, { gitBranch })
    const internals = app as unknown as AppInternals

    app.render({
      ...internals.controller.current,
      running: true,
      models: {
        current: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
        routable: true,
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
    const internals = app as unknown as AppInternals
    const submit = vi.fn(async () => {})
    internals.submit = submit

    internals.editor.setText('first prompt')
    internals.editor.handleInput('\r')
    expect(submit).toHaveBeenCalledWith('first prompt')

    internals.editor.handleInput('\u001b[A')
    expect(internals.editor.getExpandedText()).toBe('first prompt')
    internals.editor.handleInput('\u001b[B')
    expect(internals.editor.getExpandedText()).toBe('')
  })

  it.each([
    ['Escape', '\u001b'],
    ['Ctrl+C', '\u0003'],
  ])('%s interrupts an approval turn without manufacturing a rejection', async (_label, input) => {
    const app = application()
    const internals = app as unknown as AppInternals
    const prompt = approvalPrompt()
    const cancel = vi.fn(async () => {})
    const answerApproval = vi.fn(async () => {})
    internals.controller.cancel = cancel
    internals.controller.answerApproval = answerApproval

    internals.requestApproval(prompt)
    expect(internals.tui.hasOverlay()).toBe(false)
    expect(internals.composerModalActive).toBe(true)

    expect(internals.handleGlobalInput(input)).toEqual({ consume: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect(answerApproval).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(internals.composerModalActive).toBe(false) })
  })

  it('exits on repeated Ctrl+C when approval cancellation does not settle', async () => {
    const exit = vi.fn()
    const app = application(undefined, undefined, { exit })
    const internals = app as unknown as AppInternals
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    internals.controller.cancel = cancel

    internals.requestApproval(approvalPrompt())
    expect(internals.handleGlobalInput('\u0003')).toEqual({ consume: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()

    expect(internals.handleGlobalInput('\u0003')).toEqual({ consume: true })
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
  })

  it('keeps explicit approval rejection separate from turn interruption', async () => {
    const app = application()
    const internals = app as unknown as AppInternals
    const prompt = approvalPrompt()
    const cancel = vi.fn(async () => {})
    const answerApproval = vi.fn(async () => {})
    internals.controller.cancel = cancel
    internals.controller.answerApproval = answerApproval

    internals.requestApproval(prompt)
    const dialog = internals.tui.getFocusedComponent()
    dialog?.handleInput?.('\u001b[B')
    dialog?.handleInput?.('\r')

    await vi.waitFor(() => {
      expect(answerApproval).toHaveBeenCalledWith(prompt, 'rejected')
      expect(internals.tui.hasOverlay()).toBe(false)
      expect(internals.composerModalActive).toBe(false)
    })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('counts physical Escape presses without treating release or repeat as the second press', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app as unknown as AppInternals
    const requestRewind = vi.fn()
    internals.requestRewind = requestRewind

    expect(internals.handleGlobalInput('\u001b')).toEqual({ consume: true })
    expect(requestRewind).not.toHaveBeenCalled()
    expect(internals.controller.current.notice).toBeUndefined()
    expect(internals.handleGlobalInput('\u001b[27;1:2u')).toEqual({ consume: true })
    expect(internals.handleGlobalInput('\u001b[27;1:3u')).toEqual({ consume: true })
    expect(requestRewind).not.toHaveBeenCalled()
    vi.setSystemTime(1_300)
    expect(internals.handleGlobalInput('\u001b')).toEqual({ consume: true })
    expect(requestRewind).toHaveBeenCalledOnce()
  })

  it('clears an idle draft with Escape and restores it with Up or hides it with Down', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app as unknown as AppInternals
    internals.editor.setText('unfinished prompt')

    expect(internals.handleGlobalInput('\u001b')).toEqual({ consume: true })
    expect(internals.editor.getExpandedText()).toBe('')
    expect(internals.status.render(100).join('\n')).toContain('↑ to restore draft')

    expect(internals.handleGlobalInput('\u001b[A')).toEqual({ consume: true })
    expect(internals.editor.getExpandedText()).toBe('unfinished prompt')
    expect(internals.handleGlobalInput('\u001b[B')).toEqual({ consume: true })
    expect(internals.editor.getExpandedText()).toBe('')
  })

  it('clears and restores text and images as one Composer draft', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const vision = visionFixture()
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => clipboardPng(),
    })
    const internals = app as unknown as AppInternals
    await internals.pasteImage()
    const attachment = internals.attachmentDrafts.snapshot[0]
    internals.editor.handleInput('inspect this')

    expect(internals.handleGlobalInput('\u001b')).toEqual({ consume: true })
    expect(internals.editor.getExpandedText()).toBe('')
    expect(internals.attachmentDrafts.snapshot).toEqual([])
    expect(internals.composerEditor.render(80).join('\n')).not.toContain('[Image #1]')

    expect(internals.handleGlobalInput('\u001b[A')).toEqual({ consume: true })
    expect(internals.editor.getExpandedText()).toBe('[Image #1] inspect this')
    expect(internals.attachmentDrafts.snapshot).toEqual([attachment])
    expect(internals.composerEditor.render(80).join('\n')).toContain('[Image #1]')

    expect(internals.handleGlobalInput('\u001b[B')).toEqual({ consume: true })
    expect(internals.editor.getExpandedText()).toBe('')
    expect(internals.attachmentDrafts.snapshot).toEqual([])
  })

  it('lets the editor dismiss autocomplete before Escape clears the draft', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    internals.editor.setText('/rew')
    vi.spyOn(internals.editor, 'isShowingAutocomplete').mockReturnValue(true)

    expect(internals.handleGlobalInput('\u001b')).toBeUndefined()
    expect(internals.editor.getExpandedText()).toBe('/rew')
  })

  it('keeps the running animation in the fixed status row above the editor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app as unknown as AppInternals
    const running = {
      ...internals.controller.current,
      connected: true,
      running: true,
      pendingSubmissions: [{
        key: 1,
        text: 'start work',
        mode: 'queue',
        intent: 'working',
      }],
    } satisfies TuiState
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
      }] as TuiState['events'],
    })
    expect(internals.status.render(80).join('\n')).toContain('Working (4s · esc to interrupt)')
    expect(internals.transcript.render(80).join('\n')).not.toContain('Working')
  })

  it('advances the transcript spinner on the shared working tick', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app as unknown as AppInternals
    const toolCall = {
      event: {
        type: 'tool/call',
        seq: 0,
        time: 1,
        data: { turn: 1, step: 1, callId: 'call-spin', name: 'read', arguments: '{}' },
      },
      view: { for: 'call', view: { card: 'generic', title: 'Read project' } },
    } as HistoryEntry
    const running = {
      ...internals.controller.current,
      connected: true,
      running: true,
      events: [toolCall],
      lifecycle: buildLifecycleSnapshot({
        sessionId: 'session-spin' as TuiState['sessionId'],
        generation: 1,
        entries: [toolCall],
        sessionRunning: true,
      }),
    } satisfies TuiState
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue(running)
    app.render(running)
    const plain = (): string => stripTerminalSequences(internals.transcript.render(80).join('\n'))

    // Collapsed activity title should not show spinner animation
    expect(plain()).toContain('› Working · 1 tool · Read')
    vi.advanceTimersByTime(160)
    expect(plain()).toContain('› Working · 1 tool · Read')
    vi.advanceTimersByTime(160)
    expect(plain()).toContain('› Working · 1 tool · Read')
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
    const internals = app as unknown as AppInternals
    const state = {
      ...internals.controller.current,
      sessionId: 'session-command' as TuiState['sessionId'],
      connected: true,
    } satisfies TuiState
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue(state)
    app.render(state)

    const pending = internals.submit('/compact')
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
    const internals = app as unknown as AppInternals
    const state = { ...internals.controller.current, connected: true } satisfies TuiState
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue(state)
    vi.spyOn(internals.controller, 'notice').mockImplementation(() => {})
    app.render(state)

    await internals.submit('/help')
    const status = stripTerminalSequences(internals.status.render(80).join('\n'))
    expect(status).toContain('Ready')
    expect(status).not.toContain('Running')
  })

  it('restarts fallback elapsed time for each optimistic activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app as unknown as AppInternals
    const base = internals.controller.current

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
    const internals = app as unknown as AppInternals

    const pendingSubmissions: TuiState['pendingSubmissions'] = [{
      key: 1,
      text: 'analyze this image',
      mode: 'queue',
      intent: 'working',
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 1, startedAt: 1_000 },
    }]
    app.render({
      ...internals.controller.current,
      connected: true,
      pendingSubmissions,
      lifecycle: buildLifecycleSnapshot({
        sessionId: undefined,
        generation: 0,
        entries: [],
        sessionRunning: false,
        runtimeActivities: [{ kind: 'vision', analysisId: 'analysis-1', startedAt: 1_000 }],
      }),
    })

    const status = internals.status.render(80).join('\n')
    expect(status).toContain('Vision · Analyzing 1 image (2s · esc to interrupt)')
    expect(status).not.toContain(' Working')
    expect(internals.transcript.render(80).join('\n')).toContain('Working · 1 tool · Vision')
    app.dispose()
  })

  it('shows compact Host task projections in the fixed ready status', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    app.render({
      ...internals.controller.current,
      connected: true,
      projections: {
        permissions: {
          currentValue: 'workspace-write',
          options: [{ value: 'workspace-write', name: 'Workspace write' }],
        },
        plan: { active: true, pending: false },
        todos: [{ content: 'Implement', status: 'in_progress' }],
      },
    } as TuiState)

    expect(internals.status.render(80).join('\n')).toContain(
      'Ready · workspace-write · Plan active',
    )
    expect(internals.status.render(80).join('\n')).not.toContain('Tasks 0/1')
  })

  it('shows the previous turn duration alongside the ready status', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    app.render({
      ...internals.controller.current,
      connected: true,
      lifecycle: buildLifecycleSnapshot({
        sessionId: undefined,
        generation: 0,
        entries: [
          { event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } },
          { event: { type: 'turn/end', seq: 1, time: 9_400, data: { turn: 1, reason: { kind: 'completed' } } } },
        ] as unknown as HistoryEntry[],
        sessionRunning: false,
      }),
    } as TuiState)

    expect(internals.status.render(80).join('\n')).toContain('Ready · last 9.4s')
    app.dispose()
  })

  it('carries only the Goal and Tasks segments down to the footer identity row', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    app.render({
      ...internals.controller.current,
      connected: true,
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
    } as TuiState)

    const footer = internals.footer.render(200).join('\n')
    expect(footer).toContain('Goal active 2/8 · Tasks 0/1')
    expect(footer).not.toContain('workspace-write')
    expect(footer).not.toContain('Plan active')
  })

  it('opens /trajectory in the current TUI and returns to the composer on Escape', async () => {
    const app = application()
    const internals = app as unknown as AppInternals

    await internals.submit('/trajectory')

    expect(internals.composerModalActive).toBe(true)
    expect(internals.trajectoryView?.render(80).join('\n')).toContain('Trajectory')
    internals.trajectoryView?.handleInput('\u001b')
    expect(internals.trajectoryView).toBeUndefined()
    expect(internals.composerModalActive).toBe(false)
  })

  it('restores the active composer surface after an approval is resolved', async () => {
    const app = application()
    const internals = app as unknown as AppInternals
    const prompt = approvalPrompt()

    await internals.submit('/trajectory')
    const trajectory = internals.tui.getFocusedComponent()
    internals.requestApproval(prompt)

    expect(internals.tui.getFocusedComponent()).not.toBe(trajectory)
    expect(internals.layout.render(80).map(stripTerminalSequences).join('\n'))
      .toContain('╭─ Permission required · shell ─')

    internals.resolveInteraction(approvalResolution(prompt, 'cancelled'))
    expect(internals.composerModalActive).toBe(true)
    expect(internals.tui.getFocusedComponent()).toBe(trajectory)
    expect(internals.layout.render(80).map(stripTerminalSequences).join('\n')).toContain('Trajectory')

    internals.trajectoryView?.handleInput('\u001b')
  })

  it('opens Config, Task, and Skill discovery as separate composer-anchored surfaces', async () => {
    const app = application()
    const internals = app as unknown as AppInternals

    await internals.submit('/config')
    expect(internals.configView?.render(80).join('\n')).toContain('Config')
    expect(internals.configView?.render(80).join('\n')).not.toContain('Goal')
    internals.configView?.handleInput('\u001b')
    expect(internals.configView).toBeUndefined()

    await internals.submit('/task')
    expect(internals.taskView?.render(80).join('\n')).toContain('Task')
    expect(internals.taskView?.render(80).join('\n')).not.toContain('Permission')
    internals.taskView?.handleInput('\u001b')
    expect(internals.taskView).toBeUndefined()

    await internals.submit('/skills')
    expect(internals.skillsView?.render(80).join('\n')).toContain('Skills')
    internals.skillsView?.handleInput('\u001b')
    expect(internals.skillsView).toBeUndefined()

    await internals.submit('/keymap')
    expect(internals.keymapView?.render(80).join('\n')).toContain('Keybindings')
    internals.keymapView?.handleInput('\u001b')
    expect(internals.keymapView).toBeUndefined()
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
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      web: { status, setSearchProvider },
    })
    const internals = app as unknown as AppInternals

    await internals.submit('/config web')

    const output = internals.webConfigView?.render(100).join('\n') ?? ''
    expect(status).toHaveBeenCalledOnce()
    expect(output).toContain('DeepSeek Official')
    expect(output).toContain('TAVILY_API_KEY missing')
    expect(output).not.toContain('must-not-appear')
    internals.webConfigView?.handleInput('G')
    internals.webConfigView?.handleInput('\r')
    await vi.waitFor(() => { expect(setSearchProvider).toHaveBeenCalledWith('deepseek-official') })
    internals.webConfigView?.handleInput('\u001b')
    expect(internals.webConfigView).toBeUndefined()
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
    const app = application(undefined, undefined, undefined, source, undefined, {
      permissionDefault: { setDefaultPreset },
    })
    const internals = app as unknown as AppInternals
    const state = {
      ...internals.controller.current,
      sessionId: 'session-permission' as TuiState['sessionId'],
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
    } as TuiState
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue(state)
    const prompt = vi.spyOn(internals.controller, 'prompt').mockResolvedValue()
    app.render(state)

    await internals.submit('/permission')
    expect(internals.configView?.render(80).join('\n')).toContain('Permission')
    expect(execute).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()

    internals.configView?.handleInput('j')
    internals.configView?.handleInput('\r')
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledWith(
        state.sessionId,
        '/permission read-only',
        expect.any(AbortSignal),
      )
      expect(setDefaultPreset).toHaveBeenCalledWith('read-only')
    })
    expect(internals.configView).toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()

    await internals.submit('/compact')
    expect(execute).toHaveBeenCalledWith(state.sessionId, '/compact', expect.any(AbortSignal))
    expect(setDefaultPreset).toHaveBeenCalledTimes(1)
    expect(prompt).not.toHaveBeenCalled()

    await internals.submit('/config permission')
    internals.configView?.handleInput('j')
    internals.configView?.handleInput('\r')
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledWith(
        state.sessionId,
        '/permission read-only',
        expect.any(AbortSignal),
      )
      expect(setDefaultPreset).toHaveBeenCalledTimes(2)
    })
    expect(internals.configView).toBeUndefined()

    await internals.submit('/permission workspace-write')
    expect(execute).toHaveBeenCalledWith(
      state.sessionId,
      '/permission workspace-write',
      expect.any(AbortSignal),
    )
    expect(setDefaultPreset).toHaveBeenLastCalledWith('workspace-write')

    await internals.submit('/config plan')
    internals.configView?.handleInput('\r')
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
    const app = application(undefined, undefined, undefined, source, undefined, {
      permissionDefault: {
        setDefaultPreset: vi.fn(async () => { throw new Error('settings are read-only') }),
      },
    })
    const internals = app as unknown as AppInternals
    const state = {
      ...internals.controller.current,
      sessionId: 'session-permission-partial' as TuiState['sessionId'],
    }
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue(state)
    const notice = vi.spyOn(internals.controller, 'notice')
    const prompt = vi.spyOn(internals.controller, 'prompt').mockResolvedValue()
    app.render(state)

    await internals.submit('/permission workspace-write')

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
    const internals = app as unknown as AppInternals
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue({
      ...internals.controller.current,
      sessionId: 'session-skills' as TuiState['sessionId'],
    })
    vi.spyOn(internals.skillCatalog, 'current', 'get').mockReturnValue({
      status: 'ready',
      entries: [{ name: 'review', description: 'Review changes', modelInvocable: true }],
    })
    vi.spyOn(internals.skillCatalog, 'refresh').mockResolvedValue([])
    const prompt = vi.spyOn(internals.controller, 'prompt').mockResolvedValue()

    await internals.submit('/review focus on races')
    await internals.submit('/control')

    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith('/review focus on races', 'queue')
    expect(internals.editor.getExpandedText()).toBe('/control')
  })

  it('submits a leading Unix absolute path as ordinary prompt text', async () => {
    const app = application()
    const internals = app as unknown as AppInternals
    const prompt = vi.spyOn(internals.controller, 'prompt').mockResolvedValue()
    const text = '/Users/yinfinity/Workplace/project/README.md 在这个文件随便写一句话'

    await internals.submit(text)

    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith(text, 'queue')
    expect(internals.editor.getExpandedText()).toBe('')
  })

  it('prints a copyable session resume command after restoring the terminal', async () => {
    const write = vi.fn(() => true)
    const exit = vi.fn()
    const app = application(undefined, undefined, {
      stdout: { write } as unknown as NodeJS.WriteStream,
      exit,
    })
    const internals = app as unknown as AppInternals
    vi.spyOn(internals.controller, 'current', 'get').mockReturnValue({
      ...internals.controller.current,
      sessionId: 'session-123' as TuiState['sessionId'],
    })
    const dispose = vi.spyOn(app, 'dispose').mockResolvedValue()

    await internals.requestExit(0)

    expect(dispose).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith('\nResume this session with:\n  dscode resume session-123\n\n')
    expect(exit).toHaveBeenCalledWith(0)
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0] ?? 0)
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0] ?? 0)
  })

})
