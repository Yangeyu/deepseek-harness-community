import { applyExecutionEntry } from './definitions.ts'
import { visionExecutionKey, thoughtExecutionKey, stepExecutionKey } from './keys.ts'
import { StepModelCallAccumulator } from './model-call.ts'
import { ExecutionReducer } from './reducer.ts'
import { ImmutableExecutionSnapshot } from './snapshot.ts'
import type { ExecutionBuildInput, ExecutionSnapshot } from './types.ts'

export class ExecutionAccumulator {
  readonly executions = new ExecutionReducer()
  readonly modelCalls = new StepModelCallAccumulator()

  apply(entry: ExecutionBuildInput['entries'][number]): void {
    applyExecutionEntry(entry, this.executions)
    this.modelCalls.apply(entry)
  }
}

/** Canonically rebuild disposable execution state from the accepted Host log. */
export function replayExecutionEntries(input: ExecutionBuildInput): ExecutionAccumulator {
  const accumulator = new ExecutionAccumulator()
  for (const entry of input.entries) accumulator.apply(entry)
  return accumulator
}

/** Add snapshot-only idle/runtime overlays without mutating the durable accumulator. */
export function materializeExecutionSnapshot(
  accumulator: ExecutionAccumulator,
  input: ExecutionBuildInput,
): ExecutionSnapshot {
  const reducer = accumulator.executions.fork()
  const assistant = input.assistant
  if (assistant?.reasoningStartedAt !== undefined) {
    const key = thoughtExecutionKey(assistant.turn, assistant.step)
    const parent = stepExecutionKey(assistant.turn, assistant.step)
    reducer.start(key, 'thought', parent, { time: assistant.reasoningStartedAt, source: 'runtime' }, 'ephemeral')
    if (assistant.reasoningEndedAt !== undefined) {
      reducer.settle(key, 'thought', parent, 'completed', { time: assistant.reasoningEndedAt, source: 'runtime' })
    }
  }
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
        `Open execution ${node.key} appeared in a non-running session tail.`,
        node.key,
      )
    }
  }

  for (const activity of input.runtimeActivities ?? []) {
    if (activity.kind !== 'vision') continue
    const key = visionExecutionKey(activity.analysisId)
    if (reducer.has(key)) continue
    reducer.start(key, 'vision', undefined, { time: activity.startedAt, source: 'runtime' }, 'ephemeral')
  }

  const result = reducer.result()
  return new ImmutableExecutionSnapshot(
    input.sessionId,
    input.epoch,
    result.nodes,
    result.diagnostics,
    accumulator.modelCalls.result(),
    input.entries,
  )
}
