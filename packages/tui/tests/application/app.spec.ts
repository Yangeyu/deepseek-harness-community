import { Editor, type Terminal } from '@earendil-works/pi-tui'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { MemoryMutation, ProjectMemoryService } from '@vascent/deepseek-harness-memory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TuiApplication,
  type TuiApplicationDependencies,
  type TuiRuntime,
} from '../../src/application/app.ts'
import { WorkspaceCheckpointStore, type RewindPreview } from '../../src/checkpoint.ts'
import { resolveConfig } from '../../src/application/config.ts'
import type { TuiState } from '../../src/runtime/controller.ts'
import type { HostCommandSource } from '../../src/runtime/commands.ts'
import {
  memoryKeymapGateway,
  type KeymapSettingsGateway,
} from '../../src/application/keymap-settings.ts'
import type { VisionGateway } from '../../src/application/attachments/coordinator.ts'
import type { NewAttachmentDraft } from '../../src/application/attachments/drafts.ts'
import { buildLifecycleSnapshot } from '../../src/runtime/lifecycle/index.ts'

interface AppInternals {
  controller: {
    current: Readonly<TuiState>
    prompt(text: string, mode: 'queue' | 'steer'): Promise<void>
    rewind(preview: RewindPreview, onProgress?: (phase: 'forking' | 'reloading') => void): Promise<string>
  }
  skillCatalog: {
    current: {
      status: 'ready'
      entries: Array<{ name: string; description: string; modelInvocable: boolean }>
    }
    refresh(force?: boolean): Promise<readonly unknown[]>
  }
  editor: Editor
  attachmentDrafts: { snapshot: readonly unknown[] }
  attachmentComposer: { render(width: number): string[] }
  footer: { render(width: number): string[] }
  status: { render(width: number): string[] }
  transcript: { render(width: number): string[] }
  trajectoryView?: { handleInput(data: string): void; render(width: number): string[] }
  configView?: { handleInput(data: string): void; render(width: number): string[] }
  keymapView?: { handleInput(data: string): void; render(width: number): string[] }
  taskView?: { handleInput(data: string): void; render(width: number): string[] }
  skillsView?: { handleInput(data: string): void; render(width: number): string[] }
  composerModalActive: boolean
  tui: { requestRender(): void }
  handleGlobalInput(data: string): { consume?: boolean } | undefined
  pasteImage(): Promise<void>
  requestRewind(): void
  performRewind(preview: RewindPreview): Promise<void>
  requestExit(code: number): Promise<void>
  submit(value: string, forcedMode?: 'queue' | 'steer'): Promise<void>
}

function memoryService(overrides: Partial<ProjectMemoryService> = {}): ProjectMemoryService {
  return {
    onActivity: () => () => {},
    ...overrides,
  } as unknown as ProjectMemoryService
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
  checkpoints: WorkspaceCheckpointStore = new WorkspaceCheckpointStore(10),
  memory: ProjectMemoryService = memoryService(),
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
    checkpoints,
    memory,
    {
      terminal: quietTerminal(),
      ...dependencies,
      ...commandSource === undefined ? {} : { commandSource },
      ...keymap === undefined ? {} : { keymap },
    },
  )
  ;(app as unknown as AppInternals).tui.requestRender = vi.fn()
  return app
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TuiApplication input routing', () => {
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

  it('coalesces concurrent clipboard events into one attachment draft', async () => {
    let resolveClipboard!: (draft: NewAttachmentDraft) => void
    const clipboardImage = vi.fn(() => new Promise<NewAttachmentDraft>((resolve) => {
      resolveClipboard = resolve
    }))
    const vision = {
      config: {
        mode: 'auto',
        proxyProvider: 'proxy',
        proxyModel: 'vision',
        maxObservationChars: 12_000,
        maxTokens: 2_048,
      },
    } as VisionGateway
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage,
    })
    const internals = app as unknown as AppInternals

    const first = internals.pasteImage()
    const second = internals.pasteImage()
    expect(clipboardImage).toHaveBeenCalledOnce()
    resolveClipboard({
      name: 'clipboard.png',
      mediaType: 'image/png',
      data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
      source: 'clipboard',
    })
    await Promise.all([first, second])

    expect(internals.attachmentDrafts.snapshot).toHaveLength(1)
    expect(internals.attachmentComposer.render(80).join('\n')).toContain('[Image #1]')
  })

  it('treats the leading image marker as one removable Composer attachment', async () => {
    const vision = {
      config: {
        mode: 'auto',
        proxyProvider: 'proxy',
        proxyModel: 'vision',
        maxObservationChars: 12_000,
        maxTokens: 2_048,
      },
    } as VisionGateway
    const app = application(undefined, undefined, undefined, undefined, undefined, {
      vision,
      clipboardImage: async () => ({
        name: 'clipboard.png',
        mediaType: 'image/png',
        data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
        source: 'clipboard',
      }),
    })
    const internals = app as unknown as AppInternals
    await internals.pasteImage()

    expect(internals.handleGlobalInput('\u007F')).toEqual({ consume: true })
    expect(internals.attachmentDrafts.snapshot).toEqual([])
    expect(internals.attachmentComposer.render(80).join('\n')).not.toContain('[Image #1]')
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

  it('keeps model identity on the first footer row and metrics on the second', () => {
    const app = application()
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
    expect(footer[0]).toContain('deepseek-official/deepseek-v4-pro · max')
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

  it('opens rewind only after two idle Escape presses within the threshold', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const app = application()
    const internals = app as unknown as AppInternals
    const requestRewind = vi.fn()
    internals.requestRewind = requestRewind

    expect(internals.handleGlobalInput('\u001b')).toEqual({ consume: true })
    expect(requestRewind).not.toHaveBeenCalled()
    expect(internals.controller.current.notice).toBeUndefined()
    vi.setSystemTime(1_300)
    expect(internals.handleGlobalInput('\u001b')).toEqual({ consume: true })
    expect(requestRewind).toHaveBeenCalledOnce()
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
    expect(internals.transcript.render(80).join('\n')).toContain('Vision · 1 image · Analyzing…')
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
      'Ready · workspace-write · Plan active · Tasks 0/1',
    )
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

  it('opens bare /permission as a picker and executes selections outside model input', async () => {
    const execute = vi.fn(async () => ({ kind: 'success' as const, text: 'preset read-only' }))
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
    const app = application(undefined, undefined, undefined, source)
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
    })
    expect(internals.configView).toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()

    await internals.submit('/compact')
    expect(execute).toHaveBeenCalledWith(state.sessionId, '/compact', expect.any(AbortSignal))
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
    })
    expect(internals.configView).toBeUndefined()

    await internals.submit('/config plan')
    internals.configView?.handleInput('\r')
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(4)
      expect(execute).toHaveBeenCalledWith(state.sessionId, '/plan', expect.any(AbortSignal))
    })
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
    expect(write).toHaveBeenCalledWith('\nResume this session with:\n  dsh-tui --resume session-123\n\n')
    expect(exit).toHaveBeenCalledWith(0)
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0] ?? 0)
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0] ?? 0)
  })

  it('restores workspace, memory mutations, and conversation as one rewind transaction', async () => {
    const rollback = vi.fn(async () => {})
    const checkpoints = {
      restore: vi.fn(async () => rollback),
      continueFrom: vi.fn(),
    } as unknown as WorkspaceCheckpointStore
    const restoreMemory = vi.fn(async () => {})
    const app = application(checkpoints, memoryService({ restore: restoreMemory }))
    const internals = app as unknown as AppInternals
    vi.spyOn(internals.controller, 'rewind').mockResolvedValue('forked-session')
    const mutation = (id: string): MemoryMutation => ({
      id,
      scope: 'project',
      summary: id,
      operation: 'write',
      files: [],
      createdAt: 1,
    })
    const first = mutation('first')
    const second = mutation('second')
    const preview: RewindPreview = {
      checkpointId: 'checkpoint',
      sessionId: 'session',
      turn: 2,
      prompt: 'fix it again',
      createdAt: 1,
      files: [],
      currentTree: 'tree',
      memoryMutations: [first, second],
    }

    await internals.performRewind(preview)

    expect(checkpoints.restore).toHaveBeenCalledWith(preview)
    expect(restoreMemory.mock.calls).toEqual([[second, 'before'], [first, 'before']])
    expect(internals.controller.rewind).toHaveBeenCalledWith(preview, expect.any(Function))
    expect(checkpoints.continueFrom).toHaveBeenCalledWith(preview, 'forked-session')
    expect(internals.editor.getExpandedText()).toBe('fix it again')
    expect(rollback).not.toHaveBeenCalled()
  })

  it('reapplies memory and workspace state when conversation rewind fails', async () => {
    const rollback = vi.fn(async () => {})
    const checkpoints = {
      restore: vi.fn(async () => rollback),
      continueFrom: vi.fn(),
    } as unknown as WorkspaceCheckpointStore
    const restoreMemory = vi.fn(async () => {})
    const app = application(checkpoints, memoryService({ restore: restoreMemory }))
    const internals = app as unknown as AppInternals
    vi.spyOn(internals.controller, 'rewind').mockRejectedValue(new Error('fork failed'))
    const remembered: MemoryMutation = {
      id: 'remembered',
      scope: 'project',
      summary: 'Remembered rule',
      operation: 'write',
      files: [],
      createdAt: 1,
    }
    const preview: RewindPreview = {
      checkpointId: 'checkpoint',
      sessionId: 'session',
      turn: 2,
      prompt: 'remember this',
      createdAt: 1,
      files: [],
      currentTree: 'tree',
      memoryMutations: [remembered],
    }

    await internals.performRewind(preview)

    expect(restoreMemory.mock.calls).toEqual([[remembered, 'before'], [remembered, 'after']])
    expect(rollback).toHaveBeenCalledOnce()
    expect(checkpoints.continueFrom).not.toHaveBeenCalled()
  })
})
