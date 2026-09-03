import type { ModelCatalog } from './contracts.ts'
import type { SessionId } from './snapshot.ts'

/** Captured Session epoch boundary for adapters whose asynchronous results update runtime facts. */
export interface SessionEffectScope {
  readonly sessionId: SessionId
  readonly epoch: number
  readonly active: boolean
  commitModelCatalog(catalog: ModelCatalog): boolean
}

export interface SessionEffectScopeSource {
  captureSession(): SessionEffectScope
}
