import { describe, expect, it, vi } from 'vitest'
import {
  TrajectoryModel,
  type TrajectoryNode,
  type TrajectoryNodeTiming,
} from '../../../src/modules/trajectory/model.ts'

type TimedNode = TrajectoryNode & TrajectoryNodeTiming

function node(overrides: Partial<TimedNode> & Pick<TimedNode, 'key' | 'kind' | 'title'>): TimedNode {
  return {
    status: 'completed',
    startedAt: 1_000,
    completedAt: 2_000,
    ...overrides,
  }
}

function openNode(overrides: Partial<TimedNode> & Pick<TimedNode, 'key' | 'kind' | 'title'>): TimedNode {
  const result = node({ status: 'running', ...overrides })
  delete result.completedAt
  return result
}

describe('TrajectoryModel', () => {
  it('indexes semantic parents and measures sibling bottlenecks', () => {
    const turn = node({ key: 'turn', kind: 'turn', turn: 1, title: 'Turn 1', completedAt: 3_000 })
    const step = node({ key: 'step', parentKey: 'turn', kind: 'step', turn: 1, step: 1, title: 'Step 1', startedAt: 1_100, completedAt: 2_900 })
    const slow = node({ key: 'slow', parentKey: 'step', kind: 'tool', turn: 1, step: 1, title: 'Slow', startedAt: 1_200, completedAt: 2_200 })
    const fast = node({ key: 'fast', parentKey: 'step', kind: 'tool', turn: 1, step: 1, title: 'Fast', startedAt: 2_300, completedAt: 2_500 })
    const model = new TrajectoryModel([turn, step, slow, fast], record => record, record => record.parentKey)

    const measurement = model.measure(4_000)

    expect(model.parentOf(step)).toBe(turn)
    expect(model.parentOf(slow)).toBe(step)
    expect(measurement.metrics.get(slow.key)).toMatchObject({
      durationMs: 1_000,
      offsetMs: 200,
      slowest: true,
      parentTitle: 'Step 1',
    })
    expect(measurement.metrics.get(fast.key)?.slowest).toBe(false)
    expect(measurement.bottleneck).toBe(slow)
  })

  it('reuses completed timing and the live read-model across static renders', () => {
    const records = Array.from({ length: 1_000 }, (_, index) => node({
      key: `tool-${index}`, kind: 'tool', title: `Tool ${index}`, completedAt: 2_000 + index,
    }))
    const timingOf = vi.fn((record: TimedNode) => record)
    const parentKeyOf = vi.fn((record: TimedNode) => record.parentKey)
    const model = new TrajectoryModel(records, timingOf, parentKeyOf)
    const first = model.measure(4_000)
    const firstMetric = first.metrics.get('tool-0')

    for (let frame = 0; frame < 100; frame++) {
      const next = model.measure(4_000 + frame)
      expect(next).toBe(first)
      expect(next.metrics.get('tool-0')).toBe(firstMetric)
    }
    expect(timingOf).toHaveBeenCalledTimes(records.length)
    expect(parentKeyOf).toHaveBeenCalledTimes(records.length)
    expect(first.bottleneck).toBe(records.at(-1))
    expect(firstMetric?.durationMs).toBe(1_000)
  })

  it('refreshes completed child shares while the running parent grows', () => {
    const parent = openNode({ key: 'step', kind: 'step', title: 'Running step' })
    const child = node({ key: 'child', parentKey: parent.key, kind: 'tool', title: 'Completed child' })
    const model = new TrajectoryModel([child, parent], record => record, record => record.parentKey)
    const measurement = model.measure(2_000)
    const childMetrics = measurement.metrics.get(child.key)!
    expect(childMetrics.shareOfParent).toBe(1)

    expect(model.measure(5_000)).toBe(measurement)
    expect(childMetrics.durationMs).toBe(1_000)
    expect(childMetrics.shareOfParent).toBe(0.25)
    expect(measurement.metrics.get(parent.key)?.durationMs).toBe(4_000)
    expect(measurement.bottleneck).toBe(child)

    // Clock rollback to a zero-duration parent removes, rather than retains, the share.
    model.measure(1_000)
    expect(childMetrics.shareOfParent).toBeUndefined()
    model.measure(3_000)
    expect(childMetrics.shareOfParent).toBe(0.5)
  })

  it('updates sibling winners and the global bottleneck in either clock direction', () => {
    const parent = node({ key: 'step', kind: 'step', title: 'Step', completedAt: 9_000 })
    const active = openNode({ key: 'active', parentKey: parent.key, kind: 'tool', title: 'Active', startedAt: 2_000 })
    const sibling = node({ key: 'sibling', parentKey: parent.key, kind: 'tool', title: 'Sibling', completedAt: 3_000 })
    const unrelated = node({ key: 'unrelated', kind: 'tool', title: 'Other branch', completedAt: 4_000 })
    const timingOf = vi.fn((record: TimedNode) => record)
    const model = new TrajectoryModel([parent, active, sibling, unrelated], timingOf, record => record.parentKey)
    const measurement = model.measure(3_000)
    expect(measurement.metrics.get(active.key)).toMatchObject({ durationMs: 1_000, shareOfParent: 0.125, slowest: false })
    expect(measurement.metrics.get(sibling.key)?.slowest).toBe(true)
    expect(measurement.bottleneck).toBe(unrelated)

    // Equal durations preserve original record order, even across static/active candidates.
    model.measure(4_000)
    expect(measurement.metrics.get(active.key)?.slowest).toBe(true)
    expect(measurement.metrics.get(sibling.key)?.slowest).toBe(false)
    expect(measurement.bottleneck).toBe(unrelated)
    model.measure(5_000)
    expect(measurement.bottleneck).toBe(active)
    model.measure(6_000)
    expect(measurement.metrics.get(active.key)?.shareOfParent).toBe(0.5)
    expect(measurement.bottleneck).toBe(active)

    model.measure(3_000)
    expect(measurement.metrics.get(sibling.key)?.slowest).toBe(true)
    expect(measurement.metrics.get(active.key)?.slowest).toBe(false)
    expect(measurement.bottleneck).toBe(unrelated)
    expect(timingOf).toHaveBeenCalledTimes(4)
  })

  it('uses ticking steps as bottleneck candidates only when no timed leaves exist', () => {
    const completed = node({ key: 'completed', kind: 'step', title: 'Completed step', completedAt: 3_000 })
    const active = openNode({ key: 'active', kind: 'step', title: 'Running step' })
    const untimed = openNode({ key: 'info', kind: 'event', title: 'Info', status: 'info' })
    const model = new TrajectoryModel([completed, active, untimed], record => record, record => record.parentKey)

    expect(model.measure(2_000).bottleneck).toBe(completed)
    expect(model.measure(3_000).bottleneck).toBe(completed)
    expect(model.measure(4_000).bottleneck).toBe(active)
    expect(model.measure(2_000).bottleneck).toBe(completed)
  })

  it('keeps turn-relative offsets and late parent links independent of clock ticks', () => {
    const child = openNode({ key: 'child', parentKey: 'turn', kind: 'tool', title: 'Child', turn: 2, startedAt: 5_500, status: 'pending' })
    const turn = node({ key: 'turn', kind: 'turn', title: 'Turn 2', turn: 2, startedAt: 5_000, completedAt: 7_000 })
    const earlier = openNode({ key: 'earlier', kind: 'event', title: 'Earlier', startedAt: 500, status: 'info' })
    const orphan = node({ key: 'orphan', parentKey: 'missing', kind: 'tool', title: 'Orphan', turn: 3 })
    const model = new TrajectoryModel([child, turn, earlier, orphan], record => record, record => record.parentKey)

    expect(model.parentOf(child)).toBe(turn)
    expect(model.parentOf(orphan)).toBeUndefined()
    expect(model.measure(6_000).metrics.get(child.key)).toMatchObject({ offsetMs: 500, durationMs: 500 })
    expect(model.measure(7_000).metrics.get(child.key)).toMatchObject({ offsetMs: 500, durationMs: 1_500 })
    expect(model.measure(7_000).metrics.get(orphan.key)?.offsetMs).toBe(500)
  })

  it('measures pending records from the render clock without inventing completed timing', () => {
    const pending: TimedNode = {
      key: 'pending',
      kind: 'tool',
      title: 'Pending',
      status: 'pending',
      startedAt: 2_000,
    }
    const informational: TimedNode = {
      key: 'info',
      kind: 'event',
      title: 'Info',
      status: 'info',
      startedAt: 2_000,
    }
    const measurement = new TrajectoryModel(
      [pending, informational],
      record => record,
      record => record.parentKey,
    ).measure(2_750)

    expect(measurement.metrics.get('pending')?.durationMs).toBe(750)
    expect(measurement.metrics.get('info')?.durationMs).toBeUndefined()
  })
})
