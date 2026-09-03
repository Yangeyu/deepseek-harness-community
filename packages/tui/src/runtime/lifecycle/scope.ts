export interface DisposableResource {
  dispose(): void | Promise<void>
}

export type LifecycleCleanup = () => void | Promise<void>

interface CleanupRegistration {
  active: boolean
  cleanup: LifecycleCleanup
}

/** Hierarchical cancellation and reverse-order ownership for runtime resources. */
export class LifecycleScope implements DisposableResource {
  private readonly abortController = new AbortController()
  private readonly cleanups: CleanupRegistration[] = []
  private readonly detachParent: (() => void) | undefined
  private disposeTask: Promise<void> | undefined

  constructor(
    readonly name: string,
    parentSignal?: AbortSignal,
  ) {
    if (parentSignal === undefined) return
    const cancel = (): void => {
      this.abortController.abort(parentSignal.reason)
    }
    if (parentSignal.aborted) {
      cancel()
      return
    }
    parentSignal.addEventListener('abort', cancel, { once: true })
    this.detachParent = () => { parentSignal.removeEventListener('abort', cancel) }
  }

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  get active(): boolean {
    return !this.signal.aborted
  }

  own<T extends DisposableResource>(resource: T): T {
    this.register(() => resource.dispose())
    return resource
  }

  onDispose(cleanup: LifecycleCleanup): void {
    this.register(cleanup)
  }

  fork(name: string): LifecycleScope {
    this.assertActive('fork a child scope')
    const child = new LifecycleScope(`${this.name}/${name}`, this.signal)
    const releaseOwnership = this.register(() => child.dispose())
    child.onDispose(releaseOwnership)
    return child
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.abortController.abort(new Error(`Lifecycle scope disposed: ${this.name}`))
    const cleanups = this.cleanups.splice(0).reverse()
    this.disposeTask = this.release(cleanups)
    return this.disposeTask
  }

  private register(cleanup: LifecycleCleanup): () => void {
    this.assertActive('own a resource')
    const registration: CleanupRegistration = { active: true, cleanup }
    this.cleanups.push(registration)
    return () => {
      if (!registration.active) return
      registration.active = false
      const index = this.cleanups.indexOf(registration)
      if (index >= 0) this.cleanups.splice(index, 1)
    }
  }

  private assertActive(operation: string): void {
    if (this.active) return
    throw new Error(`Cannot ${operation} in inactive lifecycle scope ${this.name}.`)
  }

  private async release(cleanups: readonly CleanupRegistration[]): Promise<void> {
    const errors: unknown[] = []
    try {
      for (const registration of cleanups) {
        if (!registration.active) continue
        registration.active = false
        try {
          await registration.cleanup()
        } catch (error: unknown) {
          errors.push(error)
        }
      }
    } finally {
      this.detachParent?.()
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to dispose lifecycle scope ${this.name}.`)
    }
  }
}
