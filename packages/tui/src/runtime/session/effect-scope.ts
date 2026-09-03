import type { ModelSelection, SessionModels } from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionId } from './snapshot.ts'

/** Captured Session epoch boundary for adapters whose asynchronous results update runtime facts. */
export interface SessionEffectScope {
  readonly sessionId: SessionId
  readonly epoch: number
  readonly active: boolean
  commitModels(models: SessionModels): boolean
  commitModelSelection(selection: ModelSelection): boolean
}

export interface SessionEffectScopeSource {
  captureSession(): SessionEffectScope
}
