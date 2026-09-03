import { applyExecutionEntry } from './definitions.ts'
import { visionExecutionKey } from './keys.ts'
import { ExecutionReducer } from './reducer.ts'
import { ImmutableExecutionSnapshot } from './snapshot.ts'
import type { ExecutionBuildInput, ExecutionSnapshot } from './types.ts'

/** Canonically rebuild disposable execution state from the accepted Host log. */
export function replayExecutionEntries(input: ExecutionBuildInput): ExecutionReducer {
  const reducer = new ExecutionReducer()
  for (const entry of input.entries) applyExecutionEntry(entry, reducer)
  return reducer
}

/** Add snapshot-only idle/runtime overlays without mutating the durable accumulator. */
export function materializeExecutionSnapshot(
  accumulator: ExecutionReducer,
  input: ExecutionBuildInput,
): ExecutionSnapshot {
  const reducer = accumulator.fork()
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
    input.entries,
  )
}
