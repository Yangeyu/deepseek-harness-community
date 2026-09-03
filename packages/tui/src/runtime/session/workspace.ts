import { AtomicSnapshotStore, type SnapshotListener } from '../dispatch/snapshot-store.ts'
import {
  SessionMachine,
  type SessionOperation,
  type SessionPresentation,
} from '../lifecycle/session-machine.ts'
import type { LifecycleScope } from '../lifecycle/scope.ts'
import { emptyRuntimeSessionSnapshot, SessionRuntime } from './runtime.ts'
import type {
  ConnectionPhase,
  RuntimeSessionSnapshot,
  SessionConnectionState,
  SessionId,
} from './snapshot.ts'
import type { SessionFeatureParticipant } from './features.ts'

export interface SessionCandidate {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly connection: SessionConnectionState
}

export interface SessionCommit {
  readonly runtime: SessionRuntime
  readonly retirement: Promise<void>
  readonly activationError?: unknown
}

/** Owns the visible, suspended, and newly committed Session scopes as one replacement boundary. */
export class SessionWorkspace {
  private readonly machine = new SessionMachine<SessionId>()
  private readonly store: AtomicSnapshotStore<RuntimeSessionSnapshot>
  private activeRuntime: SessionRuntime | undefined
  private suspendedRuntime: SessionRuntime | undefined
  private detachActive: (() => void) | undefined
  private featureParticipant: SessionFeatureParticipant | undefined

  constructor(
    private readonly scope: LifecycleScope,
    cwd: string,
  ) {
    this.store = new AtomicSnapshotStore(emptyRuntimeSessionSnapshot(cwd, {
      mux: 'connecting',
      host: 'connecting',
    }, 0))
  }

  get current(): Readonly<RuntimeSessionSnapshot> {
    return this.store.current
  }

  get active(): SessionRuntime | undefined {
    return this.activeRuntime
  }

  subscribe(listener: SnapshotListener<RuntimeSessionSnapshot>): () => void {
    return this.store.subscribe(listener)
  }

  registerFeatureParticipant(participant: SessionFeatureParticipant): () => void {
    if (this.featureParticipant !== undefined) {
      throw new Error('A Session feature participant is already registered.')
    }
    this.featureParticipant = participant
    return () => {
      if (this.featureParticipant === participant) this.featureParticipant = undefined
    }
  }

  begin(requestedPresentation: SessionPresentation): SessionOperation<SessionId> {
    const inheritEmptyPresentation = this.activeRuntime === undefined && this.suspendedRuntime !== undefined
    const presentation = requestedPresentation === 'empty' || inheritEmptyPresentation
      ? 'empty'
      : 'previous'
    if (presentation === 'empty' && this.activeRuntime !== undefined) {
      this.detachActive?.()
      this.detachActive = undefined
      this.suspendedRuntime = this.activeRuntime
      this.activeRuntime = undefined
    }
    const previous = this.activeRuntime ?? this.suspendedRuntime
    const operation = this.machine.begin(previous?.sessionId, presentation)
    this.featureParticipant?.prepare(operation)
    if (presentation === 'empty') {
      this.publishEmpty(this.current.cwd, this.current.connection, this.machine.binding)
    } else if (this.activeRuntime !== undefined) {
      this.activeRuntime.setBinding(this.machine.binding)
    } else {
      this.store.update(snapshot => ({ ...snapshot, binding: this.machine.binding }))
    }
    return operation
  }

  commit(operation: SessionOperation<SessionId>, candidate: SessionCandidate): SessionCommit | undefined {
    const epoch = this.machine.commit(operation, candidate.sessionId)
    if (epoch === undefined) return undefined

    const retired = new Set([this.activeRuntime, this.suspendedRuntime].filter(
      (runtime): runtime is SessionRuntime => runtime !== undefined,
    ))
    this.detachActive?.()
    this.detachActive = undefined
    this.activeRuntime = undefined
    this.suspendedRuntime = undefined

    const runtime = new SessionRuntime(
      this.scope.fork(`session:${String(candidate.sessionId)}:${String(epoch)}`),
      candidate.sessionId,
      epoch,
      candidate.cwd,
      candidate.connection,
    )
    this.activeRuntime = runtime
    this.attach(runtime)
    this.store.replace(runtime.current as RuntimeSessionSnapshot)

    const retirement = Promise.all([...retired].map(previous => previous.dispose())).then(() => undefined)
    let activationError: unknown
    if (this.featureParticipant !== undefined) {
      const featureScope = runtime.forkScope('features')
      try {
        this.featureParticipant.activate({
          scope: featureScope,
          sessionId: runtime.sessionId,
          epoch: runtime.epoch,
          runtime: runtime.current,
        })
      } catch (error: unknown) {
        activationError = error
        const activationMessage = `Session features failed to start: ${error instanceof Error ? error.message : String(error)}`
        runtime.setError(activationMessage)
        void featureScope.dispose().catch((cleanupError: unknown) => {
          runtime.setError(`${activationMessage}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        })
      }
    }
    return activationError === undefined
      ? { runtime, retirement }
      : { runtime, retirement, activationError }
  }

  rollback(operation: SessionOperation<SessionId>): boolean {
    if (!this.machine.rollback(operation)) return false
    if (operation.presentation !== 'empty') {
      if (this.activeRuntime !== undefined) this.activeRuntime.setBinding(this.machine.binding)
      else this.store.update(snapshot => ({ ...snapshot, binding: this.machine.binding }))
      this.featureParticipant?.rollback(operation)
      return true
    }
    const restored = this.suspendedRuntime
    this.suspendedRuntime = undefined
    this.activeRuntime = restored
    if (restored === undefined) {
      this.publishEmpty(this.current.cwd, this.current.connection, this.machine.binding)
      this.featureParticipant?.rollback(operation)
      return true
    }
    restored.setBinding(this.machine.binding)
    this.attach(restored)
    this.store.replace(restored.current as RuntimeSessionSnapshot)
    this.featureParticipant?.rollback(operation)
    return true
  }

  fail(operation: SessionOperation<SessionId>, message: string): boolean {
    if (operation.sessionId !== undefined) return this.rollback(operation)
    if (!this.machine.fail(operation, message)) return false
    this.publishEmpty(this.current.cwd, this.current.connection, this.machine.binding, message)
    this.featureParticipant?.fail(operation)
    return true
  }

  runtimeFor(sessionId: SessionId): SessionRuntime | undefined {
    if (this.activeRuntime?.sessionId === sessionId) return this.activeRuntime
    if (this.suspendedRuntime?.sessionId === sessionId) return this.suspendedRuntime
    return undefined
  }

  owns(runtime: SessionRuntime): boolean {
    return (runtime === this.activeRuntime || runtime === this.suspendedRuntime)
      && this.machine.owns(runtime.epoch, runtime.sessionId)
      && runtime.active
  }

  visible(runtime: SessionRuntime): boolean {
    return runtime === this.activeRuntime
  }

  notice(message: string): void {
    if (this.activeRuntime !== undefined) {
      this.activeRuntime.notice(message)
      return
    }
    this.store.update(snapshot => ({ ...snapshot, notice: message, error: undefined }))
  }

  setConnection(channel: keyof SessionConnectionState, phase: ConnectionPhase, error?: string): void {
    this.activeRuntime?.setConnection(channel, phase, error)
    this.suspendedRuntime?.setConnection(channel, phase, error)
    if (this.activeRuntime === undefined) {
      this.store.update(snapshot => ({
        ...snapshot,
        connection: { ...snapshot.connection, [channel]: phase },
        error: error ?? snapshot.error,
      }))
    }
  }

  setError(message: string): void {
    if (this.activeRuntime !== undefined) {
      this.activeRuntime.setError(message)
      return
    }
    this.suspendedRuntime?.setError(message)
    this.store.update(snapshot => ({ ...snapshot, error: message }))
  }

  dispose(): Promise<void> {
    return this.scope.dispose()
  }

  private attach(runtime: SessionRuntime): void {
    this.detachActive?.()
    this.detachActive = runtime.subscribe((snapshot) => {
      if (runtime === this.activeRuntime) this.store.replace(snapshot as RuntimeSessionSnapshot)
    })
  }

  private publishEmpty(
    cwd: string,
    connection: SessionConnectionState,
    binding = this.machine.binding,
    error?: string,
  ): void {
    const empty = emptyRuntimeSessionSnapshot(cwd, connection, this.machine.epoch, binding)
    this.store.replace(error === undefined ? empty : { ...empty, error })
  }
}
