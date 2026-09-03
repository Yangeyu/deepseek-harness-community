import { describe, expect, it, vi } from 'vitest'
import {
  BoundSession,
  SessionFeatureCoordinator,
  type SessionFeatureHosts,
  type SessionFeatureSet,
} from '../../src/application/session-features.ts'
import { LifecycleScope } from '../../src/runtime/lifecycle/scope.ts'
import type { SessionOperation } from '../../src/runtime/lifecycle/session-machine.ts'
import type { SessionManager } from '../../src/runtime/session/manager.ts'
import { emptyRuntimeSessionSnapshot } from '../../src/runtime/session/runtime.ts'
import type { RuntimeSessionSnapshot, SessionId } from '../../src/runtime/session/snapshot.ts'
import { buildExecutionSnapshot } from '../../src/runtime/execution/projection/index.ts'

function operation(id: number, presentation: 'previous' | 'empty'): SessionOperation<SessionId> {
  return {
    id,
    epoch: 0,
    sessionId: 'session-old' as SessionId,
    presentation,
  }
}

function featureSet(scope: LifecycleScope, sessionId?: string, epoch = 0): SessionFeatureSet {
  return {
    scope,
    composer: {} as SessionFeatureSet['composer'],
    interaction: {} as SessionFeatureSet['interaction'],
    skills: {} as SessionFeatureSet['skills'],
    task: {} as SessionFeatureSet['task'],
    trajectory: {} as SessionFeatureSet['trajectory'],
    transcript: {} as SessionFeatureSet['transcript'],
    ...sessionId === undefined
      ? {}
      : { identity: { sessionId: sessionId as SessionId, epoch } },
  }
}

function hostFixture() {
  const bind = vi.fn()
  const host = { bind }
  return {
    bind,
    hosts: {
      composer: host,
      interaction: host,
      skills: host,
      task: host,
      trajectory: host,
      transcript: host,
    } as unknown as SessionFeatureHosts,
  }
}

describe('SessionFeatureCoordinator', () => {
  it('hides one complete feature set for clear rollback and restores the same instances', () => {
    const test = hostFixture()
    const bootstrap = featureSet(new LifecycleScope('bootstrap'))
    const create = vi.fn()
    const coordinator = new SessionFeatureCoordinator(test.hosts, bootstrap, create)
    test.bind.mockClear()

    const clearing = operation(1, 'empty')
    coordinator.prepare(clearing)
    expect(test.bind).toHaveBeenCalledTimes(6)
    expect(test.bind.mock.calls.every(call => call[0] === undefined)).toBe(true)

    test.bind.mockClear()
    coordinator.rollback(clearing)
    expect(test.bind).toHaveBeenCalledTimes(6)
    expect(test.bind.mock.calls.some(call => call[0] === bootstrap.composer)).toBe(true)
    expect(bootstrap.scope.active).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('constructs a fresh set for the committed epoch and retires the previous scope', () => {
    const test = hostFixture()
    const bootstrap = featureSet(new LifecycleScope('bootstrap'))
    const nextScope = new LifecycleScope('session/features')
    const next = featureSet(nextScope, 'session-next', 1)
    const create = vi.fn(() => next)
    const coordinator = new SessionFeatureCoordinator(test.hosts, bootstrap, create)
    test.bind.mockClear()

    coordinator.activate({
      scope: nextScope,
      sessionId: 'session-next' as SessionId,
      epoch: 1,
      runtime: emptyRuntimeSessionSnapshot('/workspace', { mux: 'online', host: 'online' }, 1),
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ epoch: 1 }), bootstrap)
    expect(bootstrap.scope.active).toBe(false)
    expect(test.bind.mock.calls.some(call => call[0] === next.composer)).toBe(true)
  })

  it('atomically unbinds the previous graph when committed-epoch construction fails', () => {
    const test = hostFixture()
    const bootstrap = featureSet(new LifecycleScope('bootstrap'))
    const coordinator = new SessionFeatureCoordinator(test.hosts, bootstrap, () => {
      throw new Error('feature graph failed')
    })
    test.bind.mockClear()

    expect(() => coordinator.activate({
      scope: new LifecycleScope('session/features'),
      sessionId: 'session-next' as SessionId,
      epoch: 1,
      runtime: emptyRuntimeSessionSnapshot('/workspace', { mux: 'online', host: 'online' }, 1),
    })).toThrow('feature graph failed')

    expect(bootstrap.scope.active).toBe(false)
    expect(test.bind).toHaveBeenCalledTimes(6)
    expect(test.bind.mock.calls.every(call => call[0] === undefined)).toBe(true)
  })
})

describe('BoundSession', () => {
  it('delivers snapshots only from its pinned Session epoch', () => {
    const scope = new LifecycleScope('session-feature')
    const sessionId = 'session-one' as SessionId
    const initial = {
      ...emptyRuntimeSessionSnapshot('/workspace', { mux: 'online', host: 'online' }, 1),
      sessionId,
      execution: buildExecutionSnapshot({
        sessionId: String(sessionId), epoch: 1, entries: [], sessionRunning: false,
      }),
    }
    let managerCurrent: Readonly<RuntimeSessionSnapshot> = initial
    const listeners = new Set<(snapshot: Readonly<RuntimeSessionSnapshot>) => void>()
    const manager = {
      get current() { return managerCurrent },
      subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as unknown as SessionManager
    const bound = new BoundSession(manager, scope, sessionId, 1, initial)
    const listener = vi.fn()
    bound.subscribe(listener)

    managerCurrent = {
      ...initial,
      sessionId: 'session-two' as SessionId,
      execution: buildExecutionSnapshot({
        sessionId: 'session-two', epoch: 2, entries: [], sessionRunning: false,
      }),
    }
    for (const notify of listeners) notify(managerCurrent)
    expect(listener).not.toHaveBeenCalled()
    expect(bound.current.sessionId).toBe(sessionId)

    managerCurrent = { ...initial, notice: 'matching update' }
    for (const notify of listeners) notify(managerCurrent)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ notice: 'matching update' }))
    expect(bound.current.notice).toBe('matching update')
  })
})
