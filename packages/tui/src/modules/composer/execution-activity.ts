import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import {
  aggregateExecution,
  executionEndedAt,
  executionStartedAt,
  visionExecutionKey,
  type ExecutionNode,
  type ExecutionSnapshot,
} from '../../runtime/execution/projection/index.ts'

export type ComposerExecutionActivity =
  | { readonly key: string; readonly kind: 'execution'; readonly startedAt?: number }
  | { readonly key: string; readonly kind: 'vision'; readonly startedAt?: number; readonly imageCount: number }

function rootKey(snapshot: ExecutionSnapshot, node: ExecutionNode): string {
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

function turnSubtree(snapshot: ExecutionSnapshot, node: ExecutionNode): readonly ExecutionNode[] {
  const nodes: ExecutionNode[] = [node]
  for (const child of snapshot.childrenOf(node.key)) nodes.push(...turnSubtree(snapshot, child))
  return nodes
}

/**
 * The previous turn's cumulative elapsed duration, measured across the whole
 * settled turn subtree so the ready status matches the trajectory's turn
 * timing (the Codex-style "worked for" marker).
 */
export function previousTurnDuration(state: Readonly<RuntimeSessionSnapshot>): number | undefined {
  const snapshot = state.execution
  const turn = snapshot.ordered().findLast(node => node.kind === 'turn' && node.state.phase === 'settled')
  if (turn === undefined) return undefined
  const nodes = turnSubtree(snapshot, turn)
  const starts = nodes.map(executionStartedAt).filter((value): value is number => value !== undefined)
  const ends = nodes.map(executionEndedAt).filter((value): value is number => value !== undefined)
  if (starts.length === 0 || ends.length === 0) return undefined
  return Math.max(0, Math.max(...ends) - Math.min(...starts)) || undefined
}

/**
 * Select the fixed Composer activity from the atomic execution snapshot.
 * Submission metadata may enrich a execution node, but never creates status.
 */
export function composerExecutionActivity(
  state: Readonly<RuntimeSessionSnapshot>,
): ComposerExecutionActivity | undefined {
  const active = state.execution.active()
  const vision = active.findLast(node => node.kind === 'vision')
  if (vision !== undefined) {
    const submission = state.pendingSubmissions.find(candidate => {
      const activity = candidate.activity
      return activity?.kind === 'vision'
        && visionExecutionKey(activity.analysisId) === vision.key
    })
    const activity = submission?.activity
    const startedAt = executionStartedAt(vision)
    return {
      key: String(vision.key),
      kind: 'vision',
      ...startedAt === undefined ? {} : { startedAt },
      imageCount: activity?.kind === 'vision' ? activity.imageCount : 0,
    }
  }

  const optimisticWork = state.pendingSubmissions.some(submission => submission.intent === 'working')
  if (state.runState === 'idle' && active.length === 0 && !optimisticWork) return undefined
  const optimistic = state.pendingSubmissions.findLast(submission => submission.intent === 'working')
  const latest = active.at(-1)
  const startedAt = aggregateExecution(active).startedAt
  return {
    key: latest === undefined
      ? optimistic === undefined
        ? `session:${String(state.sessionId)}:${String(state.execution.epoch)}`
        : `submission:${String(optimistic.key)}`
      : rootKey(state.execution, latest),
    kind: 'execution',
    ...startedAt === undefined ? {} : { startedAt },
  }
}
