import type { ModelCatalog, ModelSelection } from './contracts.ts'
import type { SessionId } from './snapshot.ts'

/** Captured Session epoch boundary for adapters whose asynchronous results update runtime facts. */
export interface SessionEffectScope {
  readonly sessionId: SessionId | undefined
  readonly epoch: number
  readonly active: boolean
  commitModelCatalog(catalog: ModelCatalog): boolean
  commitModelSelection(selection: ModelSelection): boolean
}

export interface SessionEffectScopeSource {
  captureSession(): SessionEffectScope
}
