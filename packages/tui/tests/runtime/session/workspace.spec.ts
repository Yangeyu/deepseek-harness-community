import { describe, expect, it, vi } from 'vitest'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { SessionWorkspace } from '../../../src/runtime/session/workspace.ts'
import type { SessionId } from '../../../src/runtime/session/snapshot.ts'

const id = (value: string): SessionId => value as SessionId
const online = { events: 'online', control: 'online' } as const

describe('SessionWorkspace', () => {
  it('publishes one committed Session epoch and retires the previous scope', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const first = workspace.begin()
    const firstCommit = workspace.commit(first, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })
    expect(firstCommit).toBeDefined()
    const previous = firstCommit?.runtime
    const listener = vi.fn()
    workspace.subscribe(listener)

    const next = workspace.begin()
    const nextCommit = workspace.commit(next, {
      sessionId: id('session-two'), cwd: '/next', connection: online,
    })
    await nextCommit?.retirement

    expect(previous?.active).toBe(false)
    expect(workspace.current).toMatchObject({ sessionId: 'session-two', cwd: '/next' })
    expect(workspace.current.execution.epoch).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-one',
      binding: { phase: 'preparing' },
    })
    await workspace.dispose()
  })

  it('keeps event follow, control, and run phases as independent lifecycle axes', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const operation = workspace.begin()
    const runtime = workspace.commit(operation, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })?.runtime
    expect(runtime).toBeDefined()

    runtime?.setRunState('running')
    runtime?.setConnection('events', 'reconnecting')
    expect(workspace.current).toMatchObject({
      runState: 'running',
      connection: { events: 'reconnecting', control: 'online' },
    })

    runtime?.setConnection('control', 'offline')
    runtime?.setRunState('interrupting')
    expect(workspace.current).toMatchObject({
      runState: 'interrupting',
      connection: { events: 'reconnecting', control: 'offline' },
    })
    await workspace.dispose()
  })

  it('publishes preparing and restores active binding around replacement rollback', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const initial = workspace.begin()
    workspace.commit(initial, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })

    const replacement = workspace.begin()
    expect(workspace.current.binding).toMatchObject({
      phase: 'preparing',
      previousSessionId: 'session-one',
    })
    expect(workspace.rollback(replacement)).toBe(true)
    expect(workspace.current.binding).toEqual({
      phase: 'active', sessionId: 'session-one', epoch: 1,
    })
    await workspace.dispose()
  })

  it('coordinates feature activation and scope retirement with the Session transaction', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const participant = {
      activate: vi.fn(),
    }
    workspace.registerFeatureParticipant(participant)

    const first = workspace.begin()
    const firstCommit = workspace.commit(first, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })
    const firstFeatureScope = participant.activate.mock.calls[0]?.[0].scope as LifecycleScope
    expect(firstFeatureScope.active).toBe(true)

    const replacement = workspace.begin()
    const secondCommit = workspace.commit(replacement, {
      sessionId: id('session-two'), cwd: '/next', connection: online,
    })
    expect(firstFeatureScope.active).toBe(false)
    expect(participant.activate).toHaveBeenCalledTimes(2)
    expect(participant.activate.mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'session-two', epoch: 2,
    })

    await Promise.all([firstCommit?.retirement, secondCommit?.retirement])
    await workspace.dispose()
  })

  it('keeps a committed Session active and publishes an explicit issue if feature activation fails', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    let failedFeatureScope: LifecycleScope | undefined
    workspace.registerFeatureParticipant({
      activate: (context) => {
        failedFeatureScope = context.scope
        throw new Error('feature graph failed')
      },
    })

    const operation = workspace.begin()
    const commit = workspace.commit(operation, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })

    expect(commit?.activationError).toBeInstanceOf(Error)
    expect(failedFeatureScope?.active).toBe(false)
    expect(workspace.current).toMatchObject({
      sessionId: 'session-one',
      binding: { phase: 'active', epoch: 1 },
      error: 'Session features failed to start: feature graph failed',
    })
    await workspace.dispose()
  })
})
