import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ModelCatalog, ModelSelection } from './contracts.ts'

/** Resolve the effective model from one durable projection and one Host catalog. */
export function selectedModel(
  catalog: ModelCatalog | undefined,
  projections: Readonly<Partial<SessionProjectionMap>>,
): ModelSelection | undefined {
  if (catalog === undefined) return undefined
  return projections.modelSelection?.next ?? catalog.default
}
