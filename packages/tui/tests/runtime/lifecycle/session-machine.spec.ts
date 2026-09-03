import { describe, expect, it } from 'vitest'
import { SessionMachine } from '../../../src/runtime/lifecycle/session-machine.ts'

describe('SessionMachine', () => {
  it('allows only the latest replacement operation to commit', () => {
    const machine = new SessionMachine<string>()
    const first = machine.begin(undefined, 'previous')
    const second = machine.begin(undefined, 'previous')

    expect(machine.commit(first, 'session-stale')).toBeUndefined()
    expect(machine.commit(second, 'session-next')).toBe(1)
    expect(machine.epoch).toBe(1)
    expect(machine.binding).toEqual({ phase: 'active', sessionId: 'session-next', epoch: 1 })
  })

  it('keeps a cleared Session as a temporary submission owner until rollback', () => {
    const machine = new SessionMachine<string>()
    const initial = machine.begin(undefined, 'previous')
    machine.commit(initial, 'session-old')
    const clearing = machine.begin('session-old', 'empty')

    expect(machine.owns(1, 'session-old')).toBe(true)
    expect(machine.rollback(clearing)).toBe(true)
    expect(machine.owns(1, 'session-old')).toBe(true)
  })

  it('invalidates the previous epoch at the durable replacement commit', () => {
    const machine = new SessionMachine<string>()
    const initial = machine.begin(undefined, 'previous')
    machine.commit(initial, 'session-old')
    const replacement = machine.begin('session-old', 'previous')

    expect(machine.commit(replacement, 'session-new')).toBe(2)
    expect(machine.owns(1, 'session-old')).toBe(false)
    expect(machine.owns(2, 'session-new')).toBe(true)
  })

  it('cannot commit or roll back the same operation twice', () => {
    const machine = new SessionMachine<string>()
    const operation = machine.begin(undefined, 'previous')

    expect(machine.commit(operation, 'session-one')).toBe(1)
    expect(machine.commit(operation, 'session-two')).toBeUndefined()
    expect(machine.rollback(operation)).toBe(false)
    expect(machine.epoch).toBe(1)
  })

  it('records an initial binding failure without fabricating a Session identity', () => {
    const machine = new SessionMachine<string>()
    const operation = machine.begin(undefined, 'previous')

    expect(machine.fail(operation, 'Host unavailable')).toBe(true)
    expect(machine.binding).toEqual({ phase: 'failed', message: 'Host unavailable', epoch: 0 })
    expect(machine.owns(0, 'session-never-created')).toBe(false)
    expect(machine.fail(operation, 'late failure')).toBe(false)
  })
})
