import type { TuiState } from '../runtime/controller.ts'
import {
  aggregateLifecycle,
  lifecycleEndedAt,
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

function turnSubtree(snapshot: LifecycleSnapshot, node: LifecycleNode): readonly LifecycleNode[] {
  const nodes: LifecycleNode[] = [node]
  for (const child of snapshot.childrenOf(node.key)) nodes.push(...turnSubtree(snapshot, child))
  return nodes
}

/**
 * The previous turn's cumulative elapsed duration, measured across the whole
 * settled turn subtree so the ready status matches the trajectory's turn
 * timing (the Codex-style "worked for" marker).
 */
export function previousTurnDuration(state: Readonly<TuiState>): number | undefined {
  const snapshot = state.lifecycle
  const turn = snapshot.ordered().findLast(node => node.kind === 'turn' && node.state.phase === 'settled')
  if (turn === undefined) return undefined
  const nodes = turnSubtree(snapshot, turn)
  const starts = nodes.map(lifecycleStartedAt).filter((value): value is number => value !== undefined)
  const ends = nodes.map(lifecycleEndedAt).filter((value): value is number => value !== undefined)
  if (starts.length === 0 || ends.length === 0) return undefined
  return Math.max(0, Math.max(...ends) - Math.min(...starts)) || undefined
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
