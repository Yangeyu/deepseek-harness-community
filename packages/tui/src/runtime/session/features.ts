import type { LifecycleScope } from '../lifecycle/scope.ts'
import type { RuntimeSessionSnapshot, SessionId } from './snapshot.ts'

/** Runtime-owned activation context offered to statically registered feature factories. */
export interface SessionFeatureContext {
  readonly scope: LifecycleScope
  readonly sessionId: SessionId | undefined
  readonly epoch: number
  readonly runtime: Readonly<RuntimeSessionSnapshot>
}

/**
 * Installs features when the workspace commits a Session or returns to a draft.
 *
 * The runtime deliberately knows nothing about the concrete modules behind this
 * contract. The application composition root installs one participant which
 * swaps the complete Session feature set as a unit.
 */
export interface SessionFeatureParticipant {
  activate(context: SessionFeatureContext): void
}
