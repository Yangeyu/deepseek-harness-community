import { AtomicSnapshotStore, type SnapshotListener } from '../dispatch/snapshot-store.ts'
import {
  SessionMachine,
  type SessionOperation,
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
import type { ModelCatalog, ModelSelection } from './contracts.ts'

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

/** Owns the draft and committed Session scopes as one replacement boundary. */
export class SessionWorkspace {
  private readonly machine = new SessionMachine<SessionId>()
  private readonly store: AtomicSnapshotStore<RuntimeSessionSnapshot>
  private activeRuntime: SessionRuntime | undefined
  private detachActive: (() => void) | undefined
  private featureParticipant: SessionFeatureParticipant | undefined

  constructor(
    private readonly scope: LifecycleScope,
    cwd: string,
  ) {
    this.store = new AtomicSnapshotStore(emptyRuntimeSessionSnapshot(cwd, {
      events: 'connecting',
      control: 'connecting',
    }, 0))
  }

  get current(): Readonly<RuntimeSessionSnapshot> {
    return this.store.current
  }

  get active(): SessionRuntime | undefined {
    return this.activeRuntime
  }

  setDraftModelCatalog(catalog: ModelCatalog): void {
    this.store.update(snapshot => ({ ...snapshot, modelCatalog: catalog }))
  }

  setDraftModelSelection(selection: ModelSelection): void {
    this.store.update(snapshot => ({
      ...snapshot,
      projections: { ...snapshot.projections, modelSelection: { lastUsed: null, next: selection } },
    }))
  }

  async reset(): Promise<void> {
    const previous = this.current
    const retired = this.activeRuntime
    this.machine.reset()
    this.detachActive?.()
    this.detachActive = undefined
    this.activeRuntime = undefined
    this.publishEmpty(previous.cwd, { ...previous.connection, events: 'online' })
    if (previous.modelCatalog !== undefined) this.setDraftModelCatalog(previous.modelCatalog)
    this.featureParticipant?.activate({
      scope: this.scope.fork(`draft:${String(this.machine.epoch)}`),
      sessionId: undefined,
      epoch: this.machine.epoch,
      runtime: this.current,
    })
    await retired?.dispose()
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

  begin(): SessionOperation<SessionId> {
    const operation = this.machine.begin(this.activeRuntime?.sessionId)
    if (this.activeRuntime !== undefined) this.activeRuntime.setBinding(this.machine.binding)
    else this.store.update(snapshot => ({ ...snapshot, binding: this.machine.binding }))
    return operation
  }

  commit(operation: SessionOperation<SessionId>, candidate: SessionCandidate): SessionCommit | undefined {
    const epoch = this.machine.commit(operation, candidate.sessionId)
    if (epoch === undefined) return undefined

    const retired = this.activeRuntime
    this.detachActive?.()
    this.detachActive = undefined
    this.activeRuntime = undefined

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

    const retirement = retired?.dispose() ?? Promise.resolve()
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
    if (this.activeRuntime !== undefined) this.activeRuntime.setBinding(this.machine.binding)
    else this.store.update(snapshot => ({ ...snapshot, binding: this.machine.binding }))
    return true
  }

  fail(operation: SessionOperation<SessionId>, message: string): boolean {
    if (operation.sessionId !== undefined) return this.rollback(operation)
    if (!this.machine.fail(operation, message)) return false
    this.store.update(snapshot => ({ ...snapshot, binding: this.machine.binding, error: message }))
    return true
  }

  runtimeFor(sessionId: SessionId): SessionRuntime | undefined {
    if (this.activeRuntime?.sessionId === sessionId) return this.activeRuntime
    return undefined
  }

  owns(runtime: SessionRuntime): boolean {
    return runtime === this.activeRuntime
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
  ): void {
    const empty = emptyRuntimeSessionSnapshot(cwd, connection, this.machine.epoch, binding)
    this.store.replace(empty)
  }
}
