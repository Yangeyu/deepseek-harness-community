import { describe, expect, it, vi } from 'vitest'
import { AtomicSnapshotStore } from '../../../src/runtime/dispatch/snapshot-store.ts'

describe('AtomicSnapshotStore', () => {
  it('publishes only complete replacement values', () => {
    const store = new AtomicSnapshotStore({ identity: 'old', events: [1], execution: [1] })
    const listener = vi.fn()
    store.subscribe(listener)

    store.replace({ identity: 'new', events: [2], execution: [2] })

    expect(store.current).toEqual({ identity: 'new', events: [2], execution: [2] })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(store.current)
  })

  it('detaches subscribers and skips identity-preserving updates', () => {
    const snapshot = { value: 1 }
    const store = new AtomicSnapshotStore(snapshot)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener, true)

    expect(store.replace(snapshot)).toBe(false)
    unsubscribe()
    store.replace({ value: 2 })

    expect(listener).toHaveBeenCalledTimes(1)
  })
})
