import { LifecycleScope } from './scope.ts'

export type ApplicationPhase = 'created' | 'starting' | 'running' | 'stopping' | 'disposed'

/** Owns the one-way application start/stop state machine and its root scope. */
export class ApplicationMachine {
  readonly scope: LifecycleScope
  private currentPhase: ApplicationPhase = 'created'
  private disposeTask: Promise<void> | undefined

  constructor(name = 'application') {
    this.scope = new LifecycleScope(name)
  }

  get phase(): ApplicationPhase {
    return this.currentPhase
  }

  get active(): boolean {
    return this.scope.active
  }

  async start(operation: (scope: LifecycleScope) => void | Promise<void>): Promise<void> {
    if (this.currentPhase !== 'created') {
      throw new Error(`Cannot start an application in phase ${this.currentPhase}.`)
    }
    this.currentPhase = 'starting'
    try {
      await operation(this.scope)
      if (!this.scope.active) {
        const reason = this.scope.signal.reason
        throw reason instanceof Error ? reason : new Error('Application startup was cancelled.')
      }
      this.currentPhase = 'running'
    } catch (startupError: unknown) {
      try {
        await this.dispose()
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [startupError, cleanupError],
          'Application startup failed and cleanup did not complete cleanly.',
        )
      }
      throw startupError
    }
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.currentPhase = 'stopping'
    this.disposeTask = this.scope.dispose().finally(() => {
      this.currentPhase = 'disposed'
    })
    return this.disposeTask
  }
}
