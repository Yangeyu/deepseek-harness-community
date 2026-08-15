import { Editor } from '@earendil-works/pi-tui'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { MemoryMutation, ProjectMemoryService } from '@yangeyu/deepseek-harness-memory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TuiApplication, type TuiRuntime } from '../src/app.ts'
import { WorkspaceCheckpointStore, type RewindPreview } from '../src/checkpoint.ts'
import { resolveConfig } from '../src/config.ts'
import type { TuiState } from '../src/controller.ts'

interface AppInternals {
  controller: {
    current: Readonly<TuiState>
    rewind(preview: RewindPreview, onProgress?: (phase: 'forking' | 'reloading') => void): Promise<string>
  }
  editor: Editor
  footer: { render(width: number): string[] }
  status: { render(width: number): string[] }
  transcript: { render(width: number): string[] }
  tui: { requestRender(): void }
  handleGlobalInput(data: string): { consume?: boolean } | undefined
  requestRewind(): void
  performRewind(preview: RewindPreview): Promise<void>
  submit(value: string, forcedMode?: 'queue' | 'steer'): Promise<void>
}

function memoryService(overrides: Partial<ProjectMemoryService> = {}): ProjectMemoryService {
  return {
    onActivity: () => () => {},
    ...overrides,
  } as unknown as ProjectMemoryService
}

function application(
  checkpoints: WorkspaceCheckpointStore = new WorkspaceCheckpointStore(10),
  memory: ProjectMemoryService = memoryService(),
): TuiApplication {
  const runtime: TuiRuntime = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: vi.fn(),
  }
  const app = new TuiApplication(
    {} as IApiClient,
    resolveConfig({ cwd: '/workspace', color: false }),
    runtime,
    checkpoints,
    memory,
  )
  ;(app as unknown as AppInternals).tui.requestRender = vi.fn()
  return app
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TuiApplication input routing', () => {
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
    expect(internals.footer.render(80).join('\n')).toContain('Esc cancel')

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
