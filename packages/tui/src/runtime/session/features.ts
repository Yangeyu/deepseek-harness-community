import type { LifecycleScope } from '../lifecycle/scope.ts'
import type { SessionOperation } from '../lifecycle/session-machine.ts'
import type { RuntimeSessionSnapshot, SessionId } from './snapshot.ts'

/** Runtime-owned activation context offered to statically registered feature factories. */
export interface SessionFeatureContext {
  readonly scope: LifecycleScope
  readonly sessionId: SessionId
  readonly epoch: number
  readonly runtime: Readonly<RuntimeSessionSnapshot>
}

/**
 * Participates in the same prepare/commit/rollback transaction as SessionRuntime.
 *
 * The runtime deliberately knows nothing about the concrete modules behind this
 * contract. The application composition root installs one participant which
 * swaps the complete Session feature set as a unit.
 */
export interface SessionFeatureParticipant {
  prepare(operation: SessionOperation<SessionId>): void
  activate(context: SessionFeatureContext): void
  rollback(operation: SessionOperation<SessionId>): void
  fail(operation: SessionOperation<SessionId>): void
}
