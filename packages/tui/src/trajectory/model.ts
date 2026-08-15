/** Minimal semantic shape required to index and measure a trace record. */
export interface TrajectoryNode {
  key: string
  kind: string
  turn?: number
  step?: number
  title: string
  status: string
  startedAt: number
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

function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

function effectiveDuration(record: TrajectoryNode, now: number): number | undefined {
  if (record.completedAt !== undefined) return Math.max(0, record.completedAt - record.startedAt)
  return record.status === 'pending' ? Math.max(0, now - record.startedAt) : undefined
}

/**
 * Immutable relationship index for one trace snapshot. Parent lookup is O(1),
 * and a complete timing measurement is O(n) even for long paged sessions.
 */
export class TrajectoryModel<T extends TrajectoryNode> {
  private readonly parents = new Map<string, T>()

  constructor(private readonly records: readonly T[]) {
    const turns = new Map<number, T>()
    const steps = new Map<string, T>()
    for (const record of records) {
      if (record.kind === 'turn' && record.turn !== undefined) turns.set(record.turn, record)
      if (record.kind === 'step' && record.turn !== undefined && record.step !== undefined) {
        steps.set(stepKey(record.turn, record.step), record)
      }
    }
    for (const record of records) {
      if (record.kind === 'turn' || record.turn === undefined) continue
      const parent = record.kind === 'step'
        ? turns.get(record.turn)
        : record.step === undefined
          ? turns.get(record.turn)
          : steps.get(stepKey(record.turn, record.step)) ?? turns.get(record.turn)
      if (parent !== undefined) this.parents.set(record.key, parent)
    }
  }

  parentOf(record: T): T | undefined {
    return this.parents.get(record.key)
  }

  measure(now: number): TrajectoryMeasurement<T> {
    const metrics = new Map<string, TrajectoryMetrics>()
    const firstStart = this.records.reduce(
      (minimum, record) => Math.min(minimum, record.startedAt),
      Number.POSITIVE_INFINITY,
    )
    const turnStarts = new Map<number, number>()
    const groups = new Map<string, Array<{ record: T; durationMs: number }>>()
    for (const record of this.records) {
      if (record.kind === 'turn' && record.turn !== undefined) turnStarts.set(record.turn, record.startedAt)
    }

    for (const record of this.records) {
      const parent = this.parentOf(record)
      const durationMs = effectiveDuration(record, now)
      const parentDurationMs = parent === undefined ? undefined : effectiveDuration(parent, now)
      const baseline = record.turn === undefined
        ? Number.isFinite(firstStart) ? firstStart : record.startedAt
        : turnStarts.get(record.turn) ?? (Number.isFinite(firstStart) ? firstStart : record.startedAt)
      metrics.set(record.key, {
        ...durationMs === undefined ? {} : { durationMs },
        offsetMs: Math.max(0, record.startedAt - baseline),
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
