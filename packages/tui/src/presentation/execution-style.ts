import type { TuiTheme } from './theme.ts'
import type { ExecutionStatus, LifecycleAggregate, LifecycleKind } from '../runtime/lifecycle/index.ts'

export interface ExecutionVisual {
  readonly glyph: string
  readonly paint: (text: string) => string
  readonly bold: boolean
}

export function executionVisual(status: ExecutionStatus, theme: TuiTheme): ExecutionVisual {
  switch (status) {
    case 'pending': return { glyph: '◦', paint: theme.warning, bold: false }
    case 'running': return { glyph: '◦', paint: theme.warning, bold: false }
    case 'completed': return { glyph: '•', paint: theme.success, bold: true }
    case 'failed': return { glyph: '×', paint: theme.error, bold: false }
    case 'interrupted': return { glyph: '!', paint: theme.warning, bold: false }
  }
}

export function executionLabel(kind: LifecycleKind, status: ExecutionStatus): string {
  if (kind === 'thought') {
    if (status === 'pending' || status === 'running') return 'Thinking…'
    if (status === 'failed') return 'Thought failed'
    if (status === 'interrupted') return 'Thought interrupted'
    return 'Thought'
  }
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

export type ExecutionDurationDensity = 'inline' | 'detail' | 'compact' | 'elapsed'

/** One execution-duration policy with density variants for each terminal surface. */
export function formatExecutionDuration(
  milliseconds: number,
  density: ExecutionDurationDensity = 'inline',
): string {
  const duration = Math.max(0, milliseconds)
  if (density === 'elapsed') return `${String(Math.floor(duration / 1_000))}s`
  if (duration < 1_000) {
    const value = String(Math.round(duration))
    return density === 'detail' ? `${value} ms` : `${value}ms`
  }
  if (duration < 60_000 || density === 'inline') {
    const decimals = density === 'detail'
      ? duration < 10_000 ? 2 : 1
      : duration < 10_000 ? 1 : 0
    const value = (duration / 1_000).toFixed(decimals)
    return density === 'detail' ? `${value} s` : `${value}s`
  }
  const minutes = Math.floor(duration / 60_000)
  const seconds = Math.floor(duration % 60_000 / 1_000)
  return density === 'detail'
    ? `${String(minutes)}m ${String(seconds)}s`
    : `${String(minutes)}m${String(seconds).padStart(2, '0')}s`
}

export function activityLabel(activity: LifecycleAggregate): string {
  const duration = activity.startedAt === undefined || activity.endedAt === undefined
    ? undefined
    : Math.max(0, activity.endedAt - activity.startedAt) || undefined
  if (activity.status === 'pending' || activity.status === 'running') return 'Working'
  if (activity.status === 'failed') {
    return duration === undefined ? 'Failed' : `Failed after ${formatExecutionDuration(duration)}`
  }
  if (activity.status === 'interrupted') {
    return duration === undefined ? 'Interrupted' : `Interrupted after ${formatExecutionDuration(duration)}`
  }
  return duration === undefined ? 'Worked' : `Worked for ${formatExecutionDuration(duration)}`
}

interface DisclosureEntry {
  manual?: boolean
  autoDisclosed: boolean
  previous?: ExecutionStatus
}

interface ActivityDisclosureEntry {
  manual?: boolean
  autoDisclosed: boolean
}

/** Interaction state keyed by semantic execution identity, never by render row. */
export class ExecutionDisclosureState {
  private readonly entries = new Map<string, DisclosureEntry>()
  private readonly activityEntries = new Map<string, ActivityDisclosureEntry>()

  observe(key: string, status: ExecutionStatus): void {
    const current = this.entries.get(key) ?? { autoDisclosed: false }
    if (status === 'failed' && current.previous !== 'failed' && current.manual === undefined) {
      current.autoDisclosed = true
    }
    current.previous = status
    this.entries.set(key, current)
  }

  expanded(key: string, globalDefault: boolean): boolean {
    const current = this.entries.get(key)
    return current?.manual ?? (globalDefault || current?.autoDisclosed === true)
  }

  toggle(key: string, globalDefault: boolean): void {
    const current = this.entries.get(key) ?? { autoDisclosed: false }
    current.manual = !this.expanded(key, globalDefault)
    this.entries.set(key, current)
  }

  /** Index presentation-only Activity state by its stable lifecycle children. */
  observeActivity(keys: readonly string[], status: ExecutionStatus): void {
    const current = keys.flatMap(key => {
      const entry = this.activityEntries.get(key)
      return entry === undefined ? [] : [entry]
    })
    const manuallyControlled = current.some(entry => entry.manual !== undefined)
    const autoDisclosed = current.some(entry => entry.autoDisclosed)
    for (const key of keys) {
      const entry = this.activityEntries.get(key) ?? { autoDisclosed: false }
      if (status === 'failed' && !manuallyControlled && !autoDisclosed) entry.autoDisclosed = true
      this.activityEntries.set(key, entry)
    }
  }

  activityExpanded(keys: readonly string[], globalDefault: boolean): boolean {
    const entries = keys.flatMap(key => {
      const entry = this.activityEntries.get(key)
      return entry === undefined ? [] : [entry]
    })
    const manual = entries.flatMap(entry => entry.manual === undefined ? [] : [entry.manual])
    if (manual.includes(false)) return false
    if (manual.includes(true)) return true
    return globalDefault || entries.some(entry => entry.autoDisclosed)
  }

  toggleActivity(keys: readonly string[], globalDefault: boolean): void {
    const next = !this.activityExpanded(keys, globalDefault)
    for (const key of keys) {
      const entry = this.activityEntries.get(key) ?? { autoDisclosed: false }
      entry.manual = next
      this.activityEntries.set(key, entry)
    }
  }

  clearOverrides(): void {
    for (const current of this.entries.values()) delete current.manual
    for (const current of this.activityEntries.values()) delete current.manual
  }

  clear(): void {
    this.entries.clear()
    this.activityEntries.clear()
  }
}
