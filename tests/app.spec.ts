import { Editor } from '@earendil-works/pi-tui'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TuiApplication, type TuiRuntime } from '../src/app.ts'
import { WorkspaceCheckpointStore } from '../src/checkpoint.ts'
import { resolveConfig } from '../src/config.ts'
import type { TuiState } from '../src/controller.ts'

interface AppInternals {
  controller: { current: Readonly<TuiState> }
  editor: Editor
  footer: { render(width: number): string[] }
  status: { render(width: number): string[] }
  transcript: { render(width: number): string[] }
  tui: { requestRender(): void }
  handleGlobalInput(data: string): { consume?: boolean } | undefined
  requestRewind(): void
  submit(value: string, forcedMode?: 'queue' | 'steer'): Promise<void>
}

function application(): TuiApplication {
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
    new WorkspaceCheckpointStore(10),
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

  it('moves the running animation into the transcript without a duplicate status row', () => {
    const app = application()
    const internals = app as unknown as AppInternals
    app.render({
      ...internals.controller.current,
      connected: true,
      running: true,
      pendingSubmissions: [{
        key: 1,
        text: 'start work',
        mode: 'queue',
        intent: 'working',
      }],
    })

    expect(internals.status.render(80)).toEqual([])
    expect(internals.transcript.render(80).join('\n')).toContain('Working…')
    expect(internals.footer.render(80).join('\n')).toContain('Esc cancel')
  })
})
