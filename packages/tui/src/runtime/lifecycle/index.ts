import { applyLifecycleEntry } from './definitions.ts'
import { visionLifecycleKey } from './keys.ts'
import { LifecycleReducer } from './reducer.ts'
import { ImmutableLifecycleSnapshot } from './snapshot.ts'
import type {
  ExecutionStatus,
  LifecycleAggregate,
  LifecycleBuildInput,
  LifecycleNode,
  LifecycleSnapshot,
} from './types.ts'

export { installPromptLifecycle, isAcceptedPromptEvent, projectPromptNode } from './host.ts'
export {
  commandLifecycleKey,
  promptLifecycleKey,
  stepLifecycleKey,
  thoughtLifecycleKey,
  toolLifecycleKey,
  turnLifecycleKey,
  visionLifecycleKey,
} from './keys.ts'
export type {
  ExecutionStatus,
  LifecycleAggregate,
  LifecycleBoundary,
  LifecycleBuildInput,
  LifecycleDiagnostic,
  LifecycleDiagnosticCode,
  LifecycleError,
  LifecycleKey,
  LifecycleKind,
  LifecycleNode,
  LifecycleOutcome,
  LifecycleSnapshot,
  PromptNode,
  PromptNodeSink,
  LifecycleState,
  RuntimeLifecycleActivity,
  RuntimeVisionActivity,
} from './types.ts'

export function executionStatus(node: LifecycleNode): ExecutionStatus {
  return node.state.phase === 'settled' ? node.state.outcome : node.state.phase
}

export function lifecycleStartedAt(node: LifecycleNode): number | undefined {
  if (node.state.phase === 'pending') return node.state.declared?.time
  return node.state.started?.time
}

export function lifecycleEndedAt(node: LifecycleNode): number | undefined {
  return node.state.phase === 'settled' ? node.state.ended.time : undefined
}

export function aggregateLifecycle(nodes: readonly LifecycleNode[]): LifecycleAggregate {
  const precedence: readonly ExecutionStatus[] = ['failed', 'interrupted', 'running', 'pending', 'completed']
  const statuses = new Set(nodes.map(executionStatus))
  const status = precedence.find(candidate => statuses.has(candidate)) ?? 'completed'
  const starts = nodes.map(lifecycleStartedAt).filter(value => value !== undefined)
  const ends = nodes.map(lifecycleEndedAt).filter(value => value !== undefined)
  return {
    status,
    ...starts.length === 0 ? {} : { startedAt: Math.min(...starts) },
    ...status === 'running' || status === 'pending' || ends.length !== nodes.length
      ? {}
      : { endedAt: Math.max(...ends) },
  }
}

export function buildLifecycleSnapshot(input: LifecycleBuildInput): LifecycleSnapshot {
  const reducer = new LifecycleReducer()
  for (const entry of input.entries) applyLifecycleEntry(entry, reducer)

  if (!input.sessionRunning) {
    for (const node of reducer.openNodes()) {
      reducer.settle(
        node.key,
        node.kind,
        node.parentKey,
        'interrupted',
        { source: 'snapshot-tail' },
      )
      reducer.diagnose(
        'open-node-idle-tail',
        `Open lifecycle ${node.key} appeared in a non-running session tail.`,
        node.key,
      )
    }
  }

  for (const activity of input.runtimeActivities ?? []) {
    if (activity.kind !== 'vision') continue
    const key = visionLifecycleKey(activity.analysisId)
    if (reducer.has(key)) continue
    reducer.start(key, 'vision', undefined, { time: activity.startedAt, source: 'runtime' }, 'ephemeral')
  }

  const result = reducer.result()
  return new ImmutableLifecycleSnapshot(
    input.sessionId,
    input.generation,
    result.nodes,
    result.diagnostics,
    input.entries,
  )
}
