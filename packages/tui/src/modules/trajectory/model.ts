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

/**
 * Live read-model owned by one TrajectoryModel, not a retained frame snapshot.
 * The next measure() updates this object and its metrics in place; consumers
 * needing historical values must copy those values before measuring again.
 */
export interface TrajectoryMeasurement<T extends TrajectoryNode> {
  metrics: ReadonlyMap<string, TrajectoryMetrics>
  bottleneck: T | undefined
}

interface MeasuredNode<T extends TrajectoryNode> {
  record: T
  order: number
  timing: TrajectoryNodeTiming
  ticking: boolean
  metrics: TrajectoryMetrics
  parent?: MeasuredNode<T>
}

/** Completed candidates reduce to one winner; only ticking candidates need rescanning. */
interface TimingGroup<T extends TrajectoryNode> {
  fixed?: MeasuredNode<T>
  active: MeasuredNode<T>[]
  winner?: MeasuredNode<T> | undefined
}

function longer<T extends TrajectoryNode>(
  current: MeasuredNode<T> | undefined,
  candidate: MeasuredNode<T>,
): MeasuredNode<T> {
  if (current === undefined) return candidate
  const difference = candidate.metrics.durationMs! - current.metrics.durationMs!
  return difference > 0 || (difference === 0 && candidate.order < current.order) ? candidate : current
}

function addCandidate<T extends TrajectoryNode>(group: TimingGroup<T>, node: MeasuredNode<T>): void {
  if (node.ticking) group.active.push(node)
  else group.fixed = longer(group.fixed, node)
}

function longest<T extends TrajectoryNode>(group: TimingGroup<T>): MeasuredNode<T> | undefined {
  return group.active.reduce<MeasuredNode<T> | undefined>(longer, group.fixed)
}

function updateShare<T extends TrajectoryNode>(node: MeasuredNode<T>): void {
  const duration = node.metrics.durationMs
  const parentDuration = node.parent?.metrics.durationMs
  if (duration === undefined || parentDuration === undefined || parentDuration <= 0) {
    delete node.metrics.shareOfParent
  } else {
    node.metrics.shareOfParent = Math.max(0, Math.min(1, duration / parentDuration))
  }
}

/**
 * One immutable record/timing snapshot with a live clock-dependent read-model.
 * Rebuild for changed records/timings. Construction is O(n); parent lookup and
 * static measure are O(1). Clock ticks visit only active nodes, their timed
 * children, and active ranking candidates, without copying the historical Map.
 */
export class TrajectoryModel<T extends TrajectoryNode> {
  private readonly nodes = new Map<string, MeasuredNode<T>>()
  private readonly active: MeasuredNode<T>[] = []
  private readonly changingShares: MeasuredNode<T>[] = []
  private readonly activeGroups: TimingGroup<T>[] = []
  private readonly bottlenecks: TimingGroup<T>
  private readonly measurement: TrajectoryMeasurement<T>
  private measuredAt: number | undefined

  constructor(
    records: readonly T[],
    timingOf: (record: T) => TrajectoryNodeTiming,
    parentKeyOf: (record: T) => string | undefined,
  ) {
    const metrics = new Map<string, TrajectoryMetrics>()
    let firstStart: number | undefined
    const turnStarts = new Map<number, number>()
    for (const [order, record] of records.entries()) {
      const timing = timingOf(record)
      const { startedAt, completedAt, status } = timing
      const ticking = startedAt !== undefined && completedAt === undefined
        && (status === 'pending' || status === 'running')
      const durationMs = startedAt === undefined
        ? undefined
        : completedAt !== undefined ? Math.max(0, completedAt - startedAt) : ticking ? 0 : undefined
      const node: MeasuredNode<T> = {
        record, order, timing, ticking,
        metrics: { ...durationMs === undefined ? {} : { durationMs }, offsetMs: 0, slowest: false },
      }
      this.nodes.set(record.key, node)
      metrics.set(record.key, node.metrics)
      if (ticking) this.active.push(node)
      if (startedAt !== undefined) {
        firstStart = firstStart === undefined ? startedAt : Math.min(firstStart, startedAt)
        if (record.kind === 'turn' && record.turn !== undefined) turnStarts.set(record.turn, startedAt)
      }
    }

    const groups = new Map<string | undefined, TimingGroup<T>>()
    const leaves: TimingGroup<T> = { active: [] }
    const steps: TimingGroup<T> = { active: [] }
    for (const node of this.nodes.values()) {
      const { record, timing, metrics } = node
      const parentKey = parentKeyOf(record)
      const parent = parentKey === undefined ? undefined : this.nodes.get(parentKey)
      if (parent !== undefined) {
        node.parent = parent
        metrics.parentTitle = parent.record.title
      }
      const baseline = record.turn === undefined
        ? firstStart ?? timing.startedAt
        : turnStarts.get(record.turn) ?? firstStart ?? timing.startedAt
      metrics.offsetMs = timing.startedAt === undefined || baseline === undefined
        ? 0 : Math.max(0, timing.startedAt - baseline)
      updateShare(node)
      if (metrics.durationMs === undefined) continue
      if (parent !== undefined && (node.ticking || parent.ticking)) this.changingShares.push(node)
      if (record.kind === 'turn') continue
      const groupKey = parent?.record.key
      let group = groups.get(groupKey)
      if (group === undefined) {
        group = { active: [] }
        groups.set(groupKey, group)
      }
      addCandidate(group, node)
      addCandidate(record.kind === 'step' ? steps : leaves, node)
    }

    for (const group of groups.values()) {
      group.winner = longest(group)
      if (group.winner !== undefined) group.winner.metrics.slowest = true
      if (group.active.length > 0) this.activeGroups.push(group)
    }
    this.bottlenecks = leaves.fixed !== undefined || leaves.active.length > 0 ? leaves : steps
    this.measurement = { metrics, bottleneck: longest(this.bottlenecks)?.record }
  }

  parentOf(record: T): T | undefined {
    return this.nodes.get(record.key)?.parent?.record
  }

  measure(now: number): TrajectoryMeasurement<T> {
    if (this.active.length === 0 || this.measuredAt === now) return this.measurement
    this.measuredAt = now
    for (const node of this.active) {
      node.metrics.durationMs = Math.max(0, now - node.timing.startedAt!)
    }
    // A completed child still changes share while its parent's duration grows.
    for (const node of this.changingShares) updateShare(node)
    for (const group of this.activeGroups) {
      const winner = longest(group)
      if (winner === group.winner) continue
      if (group.winner !== undefined) group.winner.metrics.slowest = false
      if (winner !== undefined) winner.metrics.slowest = true
      group.winner = winner
    }
    this.measurement.bottleneck = longest(this.bottlenecks)?.record
    return this.measurement
  }
}
