import type { TuiState } from '../runtime/controller.ts'
import {
  aggregateLifecycle,
  lifecycleStartedAt,
  visionLifecycleKey,
  type LifecycleNode,
  type LifecycleSnapshot,
} from '../runtime/lifecycle/index.ts'

export type ComposerExecutionActivity =
  | { readonly key: string; readonly kind: 'execution'; readonly startedAt?: number }
  | { readonly key: string; readonly kind: 'vision'; readonly startedAt?: number; readonly imageCount: number }

function rootKey(snapshot: LifecycleSnapshot, node: LifecycleNode): string {
  let key = node.key
  let parentKey = node.parentKey
  const visited = new Set<string>([key])
  while (parentKey !== undefined && !visited.has(parentKey)) {
    key = parentKey
    visited.add(parentKey)
    parentKey = snapshot.get(parentKey)?.parentKey
  }
  return String(key)
}

/**
 * Select the fixed Composer activity from the atomic lifecycle snapshot.
 * Submission metadata may enrich a lifecycle node, but never creates status.
 */
export function composerExecutionActivity(
  state: Readonly<TuiState>,
): ComposerExecutionActivity | undefined {
  const active = state.lifecycle.active()
  const vision = active.findLast(node => node.kind === 'vision')
  if (vision !== undefined) {
    const submission = state.pendingSubmissions.find(candidate => {
      const activity = candidate.activity
      return activity?.kind === 'vision'
        && visionLifecycleKey(activity.analysisId) === vision.key
    })
    const activity = submission?.activity
    const startedAt = lifecycleStartedAt(vision)
    return {
      key: String(vision.key),
      kind: 'vision',
      ...startedAt === undefined ? {} : { startedAt },
      imageCount: activity?.kind === 'vision' ? activity.imageCount : 0,
    }
  }

  const optimisticWork = state.pendingSubmissions.some(submission => submission.intent === 'working')
  if (!state.running && active.length === 0 && !optimisticWork) return undefined
  const optimistic = state.pendingSubmissions.findLast(submission => submission.intent === 'working')
  const latest = active.at(-1)
  const startedAt = aggregateLifecycle(active).startedAt
  return {
    key: latest === undefined
      ? optimistic === undefined
        ? `session:${String(state.sessionId)}:${String(state.lifecycle.generation)}`
        : `submission:${String(optimistic.key)}`
      : rootKey(state.lifecycle, latest),
    kind: 'execution',
    ...startedAt === undefined ? {} : { startedAt },
  }
}
