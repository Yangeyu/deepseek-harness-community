import type {
  ExecutionAggregate,
  ExecutionKind,
  ExecutionStatus,
} from '../../runtime/execution/projection/index.ts'
import { formatDuration } from '../../presentation/primitives/duration.ts'

export function executionLabel(kind: ExecutionKind, status: ExecutionStatus): string {
  if (kind === 'thought') {
    if (status === 'pending' || status === 'running') return 'Thinking…'
    if (status === 'failed') return 'Thought failed'
    if (status === 'interrupted') return 'Thought interrupted'
    return 'Thought'
  }
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

export function activityLabel(activity: ExecutionAggregate): string {
  const duration = activity.startedAt === undefined || activity.endedAt === undefined
    ? undefined
    : Math.max(0, activity.endedAt - activity.startedAt) || undefined
  if (activity.status === 'pending' || activity.status === 'running') return 'Working'
  if (activity.status === 'failed') {
    return duration === undefined ? 'Failed' : `Failed after ${formatDuration(duration)}`
  }
  if (activity.status === 'interrupted') {
    return duration === undefined ? 'Interrupted' : `Interrupted after ${formatDuration(duration)}`
  }
  return duration === undefined ? 'Worked' : `Worked for ${formatDuration(duration)}`
}

/** Transcript disclosure keyed by semantic execution identity, never render rows. */
export class ExecutionDisclosureState {
  private readonly entries = new Map<string, boolean>()
  private readonly activityEntries = new Map<string, boolean>()

  expanded(key: string, globalDefault: boolean): boolean {
    return this.entries.get(key) ?? globalDefault
  }

  toggle(key: string, globalDefault: boolean): void {
    this.entries.set(key, !this.expanded(key, globalDefault))
  }

  activityExpanded(keys: readonly string[], globalDefault: boolean): boolean {
    const overrides = keys.flatMap(key => {
      const entry = this.activityEntries.get(key)
      return entry === undefined ? [] : [entry]
    })
    if (overrides.includes(false)) return false
    if (overrides.includes(true)) return true
    return globalDefault
  }

  toggleActivity(keys: readonly string[], globalDefault: boolean): void {
    const next = !this.activityExpanded(keys, globalDefault)
    for (const key of keys) this.activityEntries.set(key, next)
  }

  clearOverrides(): void {
    this.clear()
  }

  clear(): void {
    this.entries.clear()
    this.activityEntries.clear()
  }
}
