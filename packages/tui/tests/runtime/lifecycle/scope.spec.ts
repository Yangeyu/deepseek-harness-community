import { describe, expect, it, vi } from 'vitest'
import { ApplicationMachine } from '../../../src/runtime/lifecycle/application-machine.ts'
import { ResourceSlot } from '../../../src/runtime/lifecycle/resource-slot.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'

describe('LifecycleScope', () => {
  it('publishes cancellation before awaiting reverse-order cleanup', async () => {
    const scope = new LifecycleScope('root')
    const events: string[] = []
    let release!: () => void
    scope.onDispose(() => { events.push('first') })
    scope.onDispose(async () => {
      events.push('second:start')
      await new Promise<void>(resolve => { release = resolve })
      events.push('second:end')
    })

    const disposal = scope.dispose()

    expect(scope.active).toBe(false)
    expect(scope.signal.aborted).toBe(true)
    expect(events).toEqual(['second:start'])
    release()
    await disposal
    expect(events).toEqual(['second:start', 'second:end', 'first'])
  })

  it('continues cleanup after failures and reports them together', async () => {
    const scope = new LifecycleScope('root')
    const events: string[] = []
    scope.onDispose(() => { events.push('first') })
    scope.onDispose(() => {
      events.push('broken')
      throw new Error('cleanup failed')
    })
    scope.onDispose(() => { events.push('last') })

    await expect(scope.dispose()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({ message: 'cleanup failed' })],
    })
    expect(events).toEqual(['last', 'broken', 'first'])
  })

  it('cancels child scopes synchronously and releases each resource once', async () => {
    const root = new LifecycleScope('root')
    const child = root.fork('session')
    const dispose = vi.fn()
    child.own({ dispose })

    const disposal = root.dispose()

    expect(child.signal.aborted).toBe(true)
    await disposal
    await child.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects new ownership after cancellation', async () => {
    const scope = new LifecycleScope('root')
    await scope.dispose()

    expect(() => scope.onDispose(() => {})).toThrow('inactive lifecycle scope')
    expect(() => scope.fork('late')).toThrow('inactive lifecycle scope')
  })
})

describe('ResourceSlot', () => {
  it('releases the previous resource on replace, clear, and final disposal', () => {
    const released: string[] = []
    const slot = new ResourceSlot<string>(resource => { released.push(resource) })

    slot.replace('first')
    slot.replace('second')
    slot.clear()
    slot.replace('third')
    slot.dispose()
    slot.dispose()

    expect(released).toEqual(['first', 'second', 'third'])
    expect(() => slot.replace('late')).toThrow('disposed slot')
  })
})

describe('ApplicationMachine', () => {
  it('starts exactly once and disposes idempotently', async () => {
    const machine = new ApplicationMachine('tui')
    const dispose = vi.fn()

    await machine.start(scope => { scope.own({ dispose }) })
    expect(machine.phase).toBe('running')
    await expect(machine.start(() => {})).rejects.toThrow('phase running')

    const first = machine.dispose()
    expect(machine.phase).toBe('stopping')
    expect(machine.active).toBe(false)
    await Promise.all([first, machine.dispose()])
    expect(machine.phase).toBe('disposed')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('publishes lifecycle phases with cancellation already visible at stopping', async () => {
    const machine = new ApplicationMachine('tui')
    const snapshots: Array<{ phase: string; active: boolean }> = []
    machine.subscribe(snapshot => { snapshots.push(snapshot) })

    await machine.start(() => {})
    const disposal = machine.dispose()

    expect(snapshots).toContainEqual({ phase: 'starting', active: true })
    expect(snapshots).toContainEqual({ phase: 'running', active: true })
    expect(snapshots).toContainEqual({ phase: 'stopping', active: false })
    await disposal
    expect(snapshots.at(-1)).toEqual({ phase: 'disposed', active: false })
  })

  it('disposes owned resources when startup fails', async () => {
    const machine = new ApplicationMachine('tui')
    const dispose = vi.fn()

    await expect(machine.start((scope) => {
      scope.own({ dispose })
      throw new Error('startup failed')
    })).rejects.toThrow('startup failed')

    expect(machine.phase).toBe('disposed')
    expect(machine.active).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
  })
})
