import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import { appendedHistoryEntries } from '../../session/event-window.ts'
import { materializeExecutionSnapshot, replayExecutionEntries } from './accumulator.ts'
import { applyExecutionEntry } from './definitions.ts'
import { thoughtExecutionKey } from './keys.ts'
import type { ExecutionReducer } from './reducer.ts'
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

function chunkChangesExecution(entry: HistoryEntry, snapshot: ExecutionSnapshot): boolean {
  if (entry.event.type !== 'assistant/chunk') return true
  const chunk = entry.event.data.chunk
  const node = snapshot.get(thoughtExecutionKey(entry.event.data.turn, entry.event.data.step))
  if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
    return node === undefined || node.state.phase === 'settled'
  }
  if (chunk.type === 'text-delta' && chunk.text !== '') {
    return node !== undefined && node.state.phase !== 'settled'
  }
  return false
}

/** Incrementally fold append-only history and rebuild only on structural window changes. */
export class ExecutionProjector {
  private input: ExecutionBuildInput | undefined
  private snapshot: ExecutionSnapshot | undefined
  private accumulator: ExecutionReducer | undefined

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
      && appended.every(entry => !chunkChangesExecution(entry, current))

    if (appended === undefined || this.accumulator === undefined) {
      this.accumulator = replayExecutionEntries(input)
    } else {
      for (const entry of appended) applyExecutionEntry(entry, this.accumulator)
    }
    this.input = input
    if (reusable) return current
    this.snapshot = materializeExecutionSnapshot(this.accumulator, input)
    return this.snapshot
  }
}
