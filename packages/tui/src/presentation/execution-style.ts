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

/**
 * One execution-duration policy with density variants for each terminal
 * surface. Sub-minute values keep per-surface granularity (ticking integer
 * seconds for `elapsed`, decimals elsewhere); every minute-scale value
 * renders through one canonical spaced form (`1m 05s`) so the status bar,
 * transcript labels, and trajectory views never diverge.
 */
export function formatExecutionDuration(
  milliseconds: number,
  density: ExecutionDurationDensity = 'inline',
): string {
  const duration = Math.max(0, milliseconds)
  if (density === 'elapsed' && duration < 60_000) {
    return `${String(Math.floor(duration / 1_000))}s`
  }
  if (duration < 1_000) {
    const value = String(Math.round(duration))
    return density === 'detail' ? `${value} ms` : `${value}ms`
  }
  if (duration < 60_000) {
    const decimals = density === 'detail'
      ? duration < 10_000 ? 2 : 1
      : duration < 10_000 ? 1 : 0
    const value = (duration / 1_000).toFixed(decimals)
    return density === 'detail' ? `${value} s` : `${value}s`
  }
  const minutes = Math.floor(duration / 60_000)
  const seconds = Math.floor(duration % 60_000 / 1_000)
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`
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

/** Interaction state keyed by semantic execution identity, never by render row. */
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
