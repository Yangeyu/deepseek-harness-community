import { describe, expect, it, vi } from 'vitest'
import { ScopedEffectRunner } from '../../../src/runtime/dispatch/effect-runner.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'

describe('ScopedEffectRunner', () => {
  it('exposes the owner signal and drops a result after scope retirement', async () => {
    const scope = new LifecycleScope('feature')
    const onError = vi.fn()
    const runner = new ScopedEffectRunner(scope, onError)
    let release!: (value: string) => void
    let signal: AbortSignal | undefined
    const result = runner.run(async (context) => {
      signal = context.signal
      return new Promise<string>(resolve => { release = resolve })
    })

    await scope.dispose()
    release('late')

    await expect(result).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a live failure once and ignores work started after retirement', async () => {
    const scope = new LifecycleScope('feature')
    const onError = vi.fn()
    const runner = new ScopedEffectRunner(scope, onError)

    await expect(runner.run(async () => { throw new Error('failed') })).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed' }))

    await scope.dispose()
    const effect = vi.fn(async () => {})
    await runner.run(effect)
    expect(effect).not.toHaveBeenCalled()
  })

  it('reports a timeout as a live failure instead of treating it as cancellation', async () => {
    const scope = new LifecycleScope('feature')
    const onError = vi.fn()
    const runner = new ScopedEffectRunner(scope, onError)
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' })

    await expect(runner.run(async () => { throw timeout })).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledWith(timeout)
    await scope.dispose()
  })
})
