import { LifecycleScope } from './scope.ts'

export type ApplicationPhase = 'created' | 'starting' | 'running' | 'stopping' | 'disposed'

export interface ApplicationLifecycleSnapshot {
  readonly phase: ApplicationPhase
  readonly active: boolean
}

/** Owns the one-way application start/stop state machine and its root scope. */
export class ApplicationMachine {
  readonly scope: LifecycleScope
  private currentPhase: ApplicationPhase = 'created'
  private disposeTask: Promise<void> | undefined
  private readonly listeners = new Set<(snapshot: Readonly<ApplicationLifecycleSnapshot>) => void>()

  constructor(name = 'application') {
    this.scope = new LifecycleScope(name)
  }

  get phase(): ApplicationPhase {
    return this.currentPhase
  }

  get active(): boolean {
    return this.scope.active
  }

  get current(): Readonly<ApplicationLifecycleSnapshot> {
    return { phase: this.currentPhase, active: this.scope.active }
  }

  subscribe(listener: (snapshot: Readonly<ApplicationLifecycleSnapshot>) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async start(operation: (scope: LifecycleScope) => void | Promise<void>): Promise<void> {
    if (this.currentPhase !== 'created') {
      throw new Error(`Cannot start an application in phase ${this.currentPhase}.`)
    }
    this.transition('starting')
    try {
      await operation(this.scope)
      if (!this.scope.active) {
        const reason = this.scope.signal.reason
        throw reason instanceof Error ? reason : new Error('Application startup was cancelled.')
      }
      this.transition('running')
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
      this.transition('disposed')
    })
    this.publish()
    return this.disposeTask
  }

  private transition(phase: ApplicationPhase): void {
    this.currentPhase = phase
    this.publish()
  }

  private publish(): void {
    const snapshot = this.current
    for (const listener of this.listeners) listener(snapshot)
  }
}
