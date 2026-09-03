import type { LifecycleScope } from '../lifecycle/scope.ts'
import type { ScopedEffect } from './contracts.ts'

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof Error && error.name === 'AbortError')
}

/** Executes feature effects only while their owning lifecycle scope is live. */
export class ScopedEffectRunner {
  constructor(
    private readonly scope: LifecycleScope,
    private readonly onError: (error: unknown) => void,
  ) {}

  run<Result>(effect: ScopedEffect<Result>): Promise<Result | undefined> {
    if (!this.scope.active) return Promise.resolve(undefined)
    return effect({ signal: this.scope.signal }).then(
      result => this.scope.active ? result : undefined,
      (error: unknown) => {
        if (isAbort(error, this.scope.signal)) return undefined
        if (this.scope.active) this.onError(error)
        return undefined
      },
    )
  }

  start(effect: ScopedEffect): void {
    void this.run(effect)
  }
}
