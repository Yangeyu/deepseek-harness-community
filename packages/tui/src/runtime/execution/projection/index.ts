import { materializeExecutionSnapshot, replayExecutionEntries } from './accumulator.ts'
import type {
  ExecutionStatus,
  ExecutionAggregate,
  ExecutionBuildInput,
  ExecutionNode,
  ExecutionSnapshot,
} from './types.ts'

export { ExecutionProjector } from './projector.ts'
export type { ModelRequest, ModelRequestBoundary, StepModelCall } from './model-call.ts'

export { installPromptProjection, isAcceptedPromptEvent, projectPromptNode } from './host.ts'
export {
  commandExecutionKey,
  promptExecutionKey,
  stepExecutionKey,
  thoughtExecutionKey,
  toolExecutionKey,
  turnExecutionKey,
  visionExecutionKey,
} from './keys.ts'
export type {
  ExecutionStatus,
  ExecutionAggregate,
  ExecutionBoundary,
  ExecutionBuildInput,
  ExecutionDiagnostic,
  ExecutionDiagnosticCode,
  ExecutionError,
  ExecutionKey,
  ExecutionKind,
  ExecutionNode,
  ExecutionOutcome,
  ExecutionSnapshot,
  PromptNode,
  PromptNodeSink,
  ExecutionState,
  RuntimeExecutionActivity,
  RuntimeVisionActivity,
} from './types.ts'

export function executionStatus(node: ExecutionNode): ExecutionStatus {
  return node.state.phase === 'settled' ? node.state.outcome : node.state.phase
}

export function executionStartedAt(node: ExecutionNode): number | undefined {
  if (node.state.phase === 'pending') return node.state.declared?.time
  return node.state.started?.time
}

export function executionEndedAt(node: ExecutionNode): number | undefined {
  return node.state.phase === 'settled' ? node.state.ended.time : undefined
}

export function aggregateExecution(nodes: readonly ExecutionNode[]): ExecutionAggregate {
  const precedence: readonly ExecutionStatus[] = ['failed', 'interrupted', 'running', 'pending', 'completed']
  const statuses = new Set(nodes.map(executionStatus))
  const status = precedence.find(candidate => statuses.has(candidate)) ?? 'completed'
  const starts = nodes.map(executionStartedAt).filter(value => value !== undefined)
  const ends = nodes.map(executionEndedAt).filter(value => value !== undefined)
  return {
    status,
    ...starts.length === 0 ? {} : { startedAt: Math.min(...starts) },
    ...status === 'running' || status === 'pending' || ends.length !== nodes.length
      ? {}
      : { endedAt: Math.max(...ends) },
  }
}

export function buildExecutionSnapshot(input: ExecutionBuildInput): ExecutionSnapshot {
  return materializeExecutionSnapshot(replayExecutionEntries(input), input)
}
