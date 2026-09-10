import { appendedHistoryEntries } from '../../session/event-window.ts'
import {
  type ExecutionAccumulator,
  materializeExecutionSnapshot,
  replayExecutionEntries,
} from './accumulator.ts'
import type {
  ExecutionBuildInput,
  ExecutionSnapshot,
  RuntimeExecutionActivity,
} from './types.ts'

function sameRuntimeActivities(
  left: readonly RuntimeExecutionActivity[] | undefined,
  right: readonly RuntimeExecutionActivity[] | undefined,
): boolean {
  const a = left ?? []
  const b = right ?? []
  return a.length === b.length && a.every((activity, index) => {
    const candidate = b[index]
    return candidate?.kind === activity.kind
      && candidate.analysisId === activity.analysisId
      && candidate.startedAt === activity.startedAt
  })
}

/** Incrementally fold append-only history and rebuild only on structural window changes. */
export class ExecutionProjector {
  private input: ExecutionBuildInput | undefined
  private snapshot: ExecutionSnapshot | undefined
  private accumulator: ExecutionAccumulator | undefined

  project(input: ExecutionBuildInput): ExecutionSnapshot {
    const previous = this.input
    const current = this.snapshot
    const sameEpoch = previous !== undefined
      && input.sessionId === previous.sessionId
      && input.epoch === previous.epoch
    const appended = !sameEpoch || previous === undefined
      ? undefined
      : appendedHistoryEntries(previous.entries, input.entries)
    const reusable = current !== undefined
      && previous !== undefined
      && sameEpoch
      && input.sessionRunning === previous.sessionRunning
      && sameRuntimeActivities(input.runtimeActivities, previous.runtimeActivities)
      && appended !== undefined
      && appended.length === 0
      && input.assistant?.turn === previous.assistant?.turn
      && input.assistant?.step === previous.assistant?.step
      && input.assistant?.reasoningStartedAt === previous.assistant?.reasoningStartedAt
      && input.assistant?.reasoningEndedAt === previous.assistant?.reasoningEndedAt

    if (appended === undefined || this.accumulator === undefined) {
      this.accumulator = replayExecutionEntries(input)
    } else {
      for (const entry of appended) this.accumulator.apply(entry)
    }
    this.input = input
    if (reusable) return current
    this.snapshot = materializeExecutionSnapshot(this.accumulator, input)
    return this.snapshot
  }
}
