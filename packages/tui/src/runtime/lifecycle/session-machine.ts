export type SessionPresentation = 'previous' | 'empty'

export interface SessionOperation<SessionId extends string> {
  readonly id: number
  readonly epoch: number
  readonly sessionId: SessionId | undefined
  readonly presentation: SessionPresentation
}

export type SessionBindingState<SessionId extends string> =
  | { readonly phase: 'unbound' }
  | {
    readonly phase: 'preparing'
    readonly operation: number
    readonly presentation: SessionPresentation
    readonly previousSessionId: SessionId | undefined
    readonly epoch: number
  }
  | { readonly phase: 'active'; readonly sessionId: SessionId; readonly epoch: number }
  | { readonly phase: 'failed'; readonly message: string; readonly epoch: number }

/** Serializes Session replacement and owns the epoch used by late-result guards. */
export class SessionMachine<SessionId extends string> {
  private operationId = 0
  private currentEpoch = 0
  private pending: SessionOperation<SessionId> | undefined
  private activeSessionId: SessionId | undefined
  private currentBinding: SessionBindingState<SessionId> = { phase: 'unbound' }

  get epoch(): number {
    return this.currentEpoch
  }

  get binding(): SessionBindingState<SessionId> {
    return this.currentBinding
  }

  begin(
    sessionId: SessionId | undefined,
    presentation: SessionPresentation,
  ): SessionOperation<SessionId> {
    const operation: SessionOperation<SessionId> = {
      id: ++this.operationId,
      epoch: this.currentEpoch,
      sessionId,
      presentation,
    }
    this.pending = operation
    this.currentBinding = {
      phase: 'preparing',
      operation: operation.id,
      presentation,
      previousSessionId: sessionId,
      epoch: operation.epoch,
    }
    return operation
  }

  isCurrent(operation: SessionOperation<SessionId>): boolean {
    return operation.id === this.pending?.id
  }

  commit(operation: SessionOperation<SessionId>, sessionId: SessionId): number | undefined {
    if (!this.isCurrent(operation)) return undefined
    this.pending = undefined
    this.currentEpoch += 1
    this.activeSessionId = sessionId
    this.currentBinding = { phase: 'active', sessionId, epoch: this.currentEpoch }
    return this.currentEpoch
  }

  rollback(operation: SessionOperation<SessionId>): boolean {
    if (!this.isCurrent(operation)) return false
    this.pending = undefined
    this.activeSessionId = operation.sessionId
    this.currentBinding = operation.sessionId === undefined
      ? { phase: 'unbound' }
      : { phase: 'active', sessionId: operation.sessionId, epoch: this.currentEpoch }
    return true
  }

  fail(operation: SessionOperation<SessionId>, message: string): boolean {
    if (!this.isCurrent(operation)) return false
    this.pending = undefined
    this.activeSessionId = operation.sessionId
    this.currentBinding = operation.sessionId === undefined
      ? { phase: 'failed', message, epoch: this.currentEpoch }
      : { phase: 'active', sessionId: operation.sessionId, epoch: this.currentEpoch }
    return true
  }

  owns(epoch: number, sessionId: SessionId): boolean {
    if (epoch !== this.currentEpoch) return false
    if (sessionId === this.activeSessionId) return true
    return this.pending?.presentation === 'empty'
      && this.pending.epoch === epoch
      && this.pending.sessionId === sessionId
  }
}
