import type { SessionSummary } from '../../../src/runtime/session/contracts.ts'
import { describe, expect, it, vi } from 'vitest'
import { SessionCenterProcess } from '../../../src/modules/session-center/process.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { emptyRuntimeSessionSnapshot } from '../../../src/runtime/session/runtime.ts'

const candidate: SessionSummary = {
  sessionId: 'session-two' as SessionSummary['sessionId'],
  updatedAt: 1,
  running: false,
  blank: false,
  cwd: '/workspace',
}

describe('SessionCenterProcess', () => {
  it('coalesces concurrent opens into one load and one surface', async () => {
    const scope = new LifecycleScope('session-center')
    let release!: (sessions: SessionSummary[]) => void
    const sessions = vi.fn(() => new Promise<SessionSummary[]>(resolve => { release = resolve }))
    let surfaceActive = false
    const open = vi.fn(() => {
      surfaceActive = true
      return {
        close: () => {
          if (!surfaceActive) return false
          surfaceActive = false
          return true
        },
      }
    })
    const process = new SessionCenterProcess({
      session: {
        current: emptyRuntimeSessionSnapshot('/workspace', { events: 'online', control: 'online' }, 0),
        sessions,
        resume: vi.fn(async () => {}),
        notice: vi.fn(),
      },
      surfaces: {
        get active() { return surfaceActive },
        open,
      },
      theme: createTheme(false),
      scope,
    })

    const first = process.open()
    const second = process.open()
    expect(second).toBe(first)
    expect(process.current).toEqual({ phase: 'loading', choices: 0 })
    expect(sessions).toHaveBeenCalledTimes(1)

    release([candidate])
    await first

    expect(open).toHaveBeenCalledTimes(1)
    expect(process.current).toEqual({ phase: 'open', choices: 1 })
    await scope.dispose()
  })

  it('returns to idle if another surface wins while sessions are loading', async () => {
    const scope = new LifecycleScope('session-center')
    let release!: (sessions: SessionSummary[]) => void
    let surfaceActive = false
    const open = vi.fn()
    const process = new SessionCenterProcess({
      session: {
        current: emptyRuntimeSessionSnapshot('/workspace', { events: 'online', control: 'online' }, 0),
        sessions: () => new Promise(resolve => { release = resolve }),
        resume: vi.fn(async () => {}),
        notice: vi.fn(),
      },
      surfaces: {
        get active() { return surfaceActive },
        open,
      },
      theme: createTheme(false),
      scope,
    })

    const loading = process.open()
    surfaceActive = true
    release([candidate])
    await loading

    expect(open).not.toHaveBeenCalled()
    expect(process.current).toEqual({ phase: 'idle', choices: 0 })
    await scope.dispose()
  })
})
