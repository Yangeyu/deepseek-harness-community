import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTheme } from '../../../../src/presentation/primitives/theme.ts'
import { ShellStatusProcess } from '../../../../src/presentation/shell/status/process.ts'
import { buildExecutionSnapshot } from '../../../../src/runtime/execution/projection/index.ts'
import { LifecycleScope } from '../../../../src/runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../../../src/runtime/session/snapshot.ts'

function sessionSnapshot(overrides: Partial<RuntimeSessionSnapshot> = {}): RuntimeSessionSnapshot {
  return {
    binding: { phase: 'active', sessionId: 'session-1' as RuntimeSessionSnapshot['sessionId'] & string, epoch: 1 },
    sessionId: 'session-1' as RuntimeSessionSnapshot['sessionId'],
    cwd: '/workspace/project',
    runState: 'idle',
    connection: { mux: 'online', host: 'online' },
    events: [],
    historyHasMore: false,
    queue: [],
    pendingSubmissions: [],
    execution: buildExecutionSnapshot({
      sessionId: 'session-1',
      epoch: 1,
      entries: [],
      sessionRunning: false,
    }),
    models: undefined,
    projections: {},
    notice: undefined,
    error: undefined,
    ...overrides,
  }
}

function fixture() {
  let current = sessionSnapshot()
  const sessionListeners = new Set<(snapshot: Readonly<RuntimeSessionSnapshot>) => void>()
  const composerListeners = new Set<() => void>()
  const composer = {
    current: { input: { rewindArmed: false, draftRecovery: 'none' as const } },
    subscribe(listener: () => void) {
      composerListeners.add(listener)
      return () => { composerListeners.delete(listener) }
    },
  }
  let command: { line: string; startedAt: number } | undefined
  let memory: { state: 'idle' | 'learning' } = { state: 'idle' }
  let now = 1_000
  const invalidate = vi.fn()
  const advanceTranscriptAnimation = vi.fn()
  const scope = new LifecycleScope('shell-status')
  const process = new ShellStatusProcess({
    title: 'dscode',
    theme: createTheme(false),
    session: {
      get current() { return current },
      subscribe(listener) {
        sessionListeners.add(listener)
        return () => { sessionListeners.delete(listener) }
      },
    },
    composer,
    commandActivity: () => command,
    memoryActivity: () => memory,
    interruption: () => ({ target: undefined, interruptingKey: undefined }),
    followsTranscript: () => true,
    advanceTranscriptAnimation,
    gitBranch: (_cwd, listener) => {
      listener('feature/lifecycle-kernel')
      return () => {}
    },
    invalidate,
    scope,
    now: () => now,
  })
  return {
    process,
    scope,
    invalidate,
    advanceTranscriptAnimation,
    setCommand(value: typeof command) { command = value },
    setMemory(value: typeof memory) { memory = value },
    setNow(value: number) { now = value },
    publishSession(value: RuntimeSessionSnapshot) {
      current = value
      for (const listener of sessionListeners) listener(value)
    },
  }
}

afterEach(() => { vi.useRealTimers() })

describe('ShellStatusProcess', () => {
  it('projects session identity and Git context into shell components', () => {
    const test = fixture()
    test.process.start()

    expect(test.process.header.render(120).join('\n')).toContain('dscode')
    expect(test.process.header.render(120).join('\n')).toContain('session-1')
    expect(test.process.footer.render(120).join('\n')).toContain('project · feature/lifecycle-kernel')
    expect(test.process.status.render(120).join('\n')).toContain('Ready')
  })

  it('refreshes from one session subscription', () => {
    const test = fixture()
    test.process.start()
    test.publishSession(sessionSnapshot({
      cwd: '/next',
      connection: { mux: 'reconnecting', host: 'online' },
    }))

    expect(test.process.header.render(120).join('\n')).toContain('/next')
    expect(test.process.status.render(120).join('\n')).toContain('mux reconnecting')
  })

  it('is ready after Mux attachment while an idle Host stream awaits its first activity', () => {
    const test = fixture()
    test.process.start()
    test.publishSession(sessionSnapshot({
      connection: { mux: 'online', host: 'connecting' },
    }))

    const status = stripTerminalSequences(test.process.status.render(120).join('\n'))
    expect(status).toContain('Ready · host awaiting activity')
  })

  it('keeps a failed Host stream visible instead of reporting readiness', () => {
    const test = fixture()
    test.process.start()
    test.publishSession(sessionSnapshot({
      connection: { mux: 'online', host: 'reconnecting' },
    }))

    const status = stripTerminalSequences(test.process.status.render(120).join('\n'))
    expect(status).toContain('host reconnecting')
    expect(status).not.toContain('Ready')
  })

  it('owns and retires the activity animation clock', async () => {
    vi.useFakeTimers()
    const test = fixture()
    test.setCommand({ line: '/compact', startedAt: 1_000 })
    test.process.start()
    expect(stripTerminalSequences(test.process.status.render(120).join('\n'))).toContain('Running /compact (0s)')

    test.setNow(1_160)
    vi.advanceTimersByTime(160)
    expect(test.advanceTranscriptAnimation).toHaveBeenCalledOnce()
    expect(stripTerminalSequences(test.process.status.render(120).join('\n')).trimStart()).toMatch(/^✢ Running/u)

    await test.scope.dispose()
    vi.advanceTimersByTime(320)
    expect(test.advanceTranscriptAnimation).toHaveBeenCalledOnce()
  })
})
