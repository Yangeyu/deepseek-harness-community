/** Minimal semantic shape required to index and measure a trace record. */
export interface TrajectoryNode {
  key: string
  parentKey?: string
  kind: string
  turn?: number
  step?: number
  title: string
}

export interface TrajectoryNodeTiming {
  status: string
  startedAt?: number
  completedAt?: number
}

export interface TrajectoryMetrics {
  durationMs?: number
  offsetMs: number
  shareOfParent?: number
  slowest: boolean
  parentTitle?: string
}

export interface TrajectoryMeasurement<T extends TrajectoryNode> {
  metrics: ReadonlyMap<string, TrajectoryMetrics>
  bottleneck: T | undefined
}

function effectiveDuration(timing: TrajectoryNodeTiming, now: number): number | undefined {
  if (timing.startedAt === undefined) return undefined
  if (timing.completedAt !== undefined) return Math.max(0, timing.completedAt - timing.startedAt)
  return timing.status === 'pending' || timing.status === 'running'
    ? Math.max(0, now - timing.startedAt)
    : undefined
}

/**
 * Immutable relationship index for one trace snapshot. Parent lookup is O(1),
 * and a complete timing measurement is O(n) even for long paged sessions.
 */
export class TrajectoryModel<T extends TrajectoryNode> {
  private readonly parents = new Map<string, T>()

  constructor(
    private readonly records: readonly T[],
    private readonly timingOf: (record: T) => TrajectoryNodeTiming,
    parentKeyOf: (record: T) => string | undefined,
  ) {
    const byKey = new Map(records.map(record => [record.key, record]))
    for (const record of records) {
      const parentKey = parentKeyOf(record)
      const parent = parentKey === undefined ? undefined : byKey.get(parentKey)
      if (parent !== undefined) this.parents.set(record.key, parent)
    }
  }

  parentOf(record: T): T | undefined {
    return this.parents.get(record.key)
  }

  measure(now: number): TrajectoryMeasurement<T> {
    const metrics = new Map<string, TrajectoryMetrics>()
    const starts = this.records
      .map(record => this.timingOf(record).startedAt)
      .filter(value => value !== undefined)
    const firstStart = starts.length === 0 ? undefined : Math.min(...starts)
    const turnStarts = new Map<number, number>()
    const groups = new Map<string, Array<{ record: T; durationMs: number }>>()
    for (const record of this.records) {
      const startedAt = this.timingOf(record).startedAt
      if (record.kind === 'turn' && record.turn !== undefined && startedAt !== undefined) {
        turnStarts.set(record.turn, startedAt)
      }
    }

    for (const record of this.records) {
      const parent = this.parentOf(record)
      const timing = this.timingOf(record)
      const parentDurationMs = parent === undefined ? undefined : effectiveDuration(this.timingOf(parent), now)
      const durationMs = effectiveDuration(timing, now)
      const startedAt = timing.startedAt
      const baseline = record.turn === undefined
        ? firstStart ?? startedAt
        : turnStarts.get(record.turn) ?? firstStart ?? startedAt
      metrics.set(record.key, {
        ...durationMs === undefined ? {} : { durationMs },
        offsetMs: startedAt === undefined || baseline === undefined ? 0 : Math.max(0, startedAt - baseline),
        ...durationMs === undefined || parentDurationMs === undefined || parentDurationMs <= 0
          ? {}
          : { shareOfParent: Math.max(0, Math.min(1, durationMs / parentDurationMs)) },
        slowest: false,
        ...parent === undefined ? {} : { parentTitle: parent.title },
      })
      if (record.kind === 'turn' || durationMs === undefined) continue
      const group = parent?.key ?? 'root'
      const siblings = groups.get(group) ?? []
      siblings.push({ record, durationMs })
      groups.set(group, siblings)
    }

    for (const siblings of groups.values()) {
      const slowest = siblings.reduce((current, candidate) => candidate.durationMs > current.durationMs
        ? candidate
        : current)
      const metric = metrics.get(slowest.record.key)
      if (metric !== undefined) metric.slowest = true
    }

    const timedLeaves = this.records.filter(record => record.kind !== 'turn'
      && record.kind !== 'step'
      && metrics.get(record.key)?.durationMs !== undefined)
    const candidates = timedLeaves.length === 0
      ? this.records.filter(record => record.kind === 'step' && metrics.get(record.key)?.durationMs !== undefined)
      : timedLeaves
    const bottleneck = candidates.reduce<T | undefined>((slowest, candidate) => {
      if (slowest === undefined) return candidate
      return (metrics.get(candidate.key)?.durationMs ?? 0) > (metrics.get(slowest.key)?.durationMs ?? 0)
        ? candidate
        : slowest
    }, undefined)

    return { metrics, bottleneck }
  }
}
