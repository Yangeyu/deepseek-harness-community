import { describe, expect, it, vi } from 'vitest'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { SessionWorkspace } from '../../../src/runtime/session/workspace.ts'
import type { SessionId } from '../../../src/runtime/session/snapshot.ts'

const id = (value: string): SessionId => value as SessionId
const online = { events: 'online', control: 'online' } as const

describe('SessionWorkspace', () => {
  it('publishes one committed Session epoch and retires the previous scope', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const first = workspace.begin('previous')
    const firstCommit = workspace.commit(first, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })
    expect(firstCommit).toBeDefined()
    const previous = firstCommit?.runtime
    const listener = vi.fn()
    workspace.subscribe(listener)

    const next = workspace.begin('previous')
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
      binding: { phase: 'preparing', presentation: 'previous' },
    })
    await workspace.dispose()
  })

  it('keeps suspended work private and publishes it only after clear rollback', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const initial = workspace.begin('previous')
    const committed = workspace.commit(initial, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })
    const runtime = committed?.runtime
    expect(runtime).toBeDefined()
    const clearing = workspace.begin('empty')
    expect(workspace.current.sessionId).toBeUndefined()

    runtime?.startSubmission('settled while hidden', 'queue')
    expect(workspace.current.pendingSubmissions).toEqual([])
    expect(workspace.rollback(clearing)).toBe(true)

    expect(workspace.current.sessionId).toBe('session-one')
    expect(workspace.current.pendingSubmissions).toEqual([expect.objectContaining({
      text: 'settled while hidden',
    })])
    await workspace.dispose()
  })

  it('lets a newer replacement inherit an earlier immediate-empty presentation', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const initial = workspace.begin('previous')
    workspace.commit(initial, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })
    const staleClear = workspace.begin('empty')
    const replacement = workspace.begin('previous')

    expect(workspace.rollback(staleClear)).toBe(false)
    expect(workspace.current.sessionId).toBeUndefined()
    expect(workspace.rollback(replacement)).toBe(true)
    expect(workspace.current.sessionId).toBe('session-one')
    await workspace.dispose()
  })

  it('keeps event follow, control, and run phases as independent lifecycle axes', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const operation = workspace.begin('previous')
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
    const initial = workspace.begin('previous')
    workspace.commit(initial, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })

    const replacement = workspace.begin('previous')
    expect(workspace.current.binding).toMatchObject({
      phase: 'preparing',
      previousSessionId: 'session-one',
      presentation: 'previous',
    })
    expect(workspace.rollback(replacement)).toBe(true)
    expect(workspace.current.binding).toEqual({
      phase: 'active', sessionId: 'session-one', epoch: 1,
    })
    await workspace.dispose()
  })

  it('coordinates feature prepare, activation, rollback, and scope retirement with the Session transaction', async () => {
    const workspace = new SessionWorkspace(new LifecycleScope('workspace'), '/workspace')
    const participant = {
      prepare: vi.fn(),
      activate: vi.fn(),
      rollback: vi.fn(),
      fail: vi.fn(),
    }
    workspace.registerFeatureParticipant(participant)

    const first = workspace.begin('previous')
    const firstCommit = workspace.commit(first, {
      sessionId: id('session-one'), cwd: '/workspace', connection: online,
    })
    const firstFeatureScope = participant.activate.mock.calls[0]?.[0].scope as LifecycleScope
    expect(firstFeatureScope.active).toBe(true)

    const clearing = workspace.begin('empty')
    expect(participant.prepare).toHaveBeenLastCalledWith(clearing)
    expect(workspace.rollback(clearing)).toBe(true)
    expect(participant.rollback).toHaveBeenLastCalledWith(clearing)
    expect(firstFeatureScope.active).toBe(true)

    const replacement = workspace.begin('previous')
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
      prepare: () => {},
      activate: (context) => {
        failedFeatureScope = context.scope
        throw new Error('feature graph failed')
      },
      rollback: () => {},
      fail: () => {},
    })

    const operation = workspace.begin('previous')
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
