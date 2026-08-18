import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import { appendedHistoryEntries } from '../event-window.ts'
import { thoughtLifecycleKey } from './keys.ts'
import type {
  LifecycleBuildInput,
  LifecycleSnapshot,
  RuntimeLifecycleActivity,
} from './types.ts'

type SnapshotBuilder = (input: LifecycleBuildInput) => LifecycleSnapshot

function sameRuntimeActivities(
  left: readonly RuntimeLifecycleActivity[] | undefined,
  right: readonly RuntimeLifecycleActivity[] | undefined,
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

function chunkChangesLifecycle(entry: HistoryEntry, snapshot: LifecycleSnapshot): boolean {
  if (entry.event.type !== 'assistant/chunk') return true
  const chunk = entry.event.data.chunk
  const node = snapshot.get(thoughtLifecycleKey(entry.event.data.turn, entry.event.data.step))
  if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
    return node === undefined || node.state.phase === 'settled'
  }
  if (chunk.type === 'text-delta' && chunk.text !== '') {
    return node !== undefined && node.state.phase !== 'settled'
  }
  return false
}

/** Reuse lifecycle semantics while append-only stream chunks leave them unchanged. */
export class LifecycleProjection {
  private input: LifecycleBuildInput | undefined
  private snapshot: LifecycleSnapshot | undefined

  constructor(private readonly build: SnapshotBuilder) {}

  project(input: LifecycleBuildInput): LifecycleSnapshot {
    const previous = this.input
    const current = this.snapshot
    const appended = previous === undefined
      ? undefined
      : appendedHistoryEntries(previous.entries, input.entries)
    const reusable = current !== undefined
      && previous !== undefined
      && input.sessionId === previous.sessionId
      && input.generation === previous.generation
      && input.sessionRunning === previous.sessionRunning
      && sameRuntimeActivities(input.runtimeActivities, previous.runtimeActivities)
      && appended !== undefined
      && appended.every(entry => !chunkChangesLifecycle(entry, current))
    this.input = input
    if (reusable) return current
    this.snapshot = this.build(input)
    return this.snapshot
  }
}
