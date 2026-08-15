import { describe, expect, it } from 'vitest'
import { TrajectoryModel, type TrajectoryNode } from '../../src/trajectory/model.ts'

function node(overrides: Partial<TrajectoryNode> & Pick<TrajectoryNode, 'key' | 'kind' | 'title'>): TrajectoryNode {
  return {
    status: 'completed',
    startedAt: 1_000,
    completedAt: 2_000,
    ...overrides,
  }
}

describe('TrajectoryModel', () => {
  it('indexes semantic parents and measures sibling bottlenecks', () => {
    const turn = node({ key: 'turn', kind: 'turn', turn: 1, title: 'Turn 1', completedAt: 3_000 })
    const step = node({ key: 'step', kind: 'step', turn: 1, step: 1, title: 'Step 1', startedAt: 1_100, completedAt: 2_900 })
    const slow = node({ key: 'slow', kind: 'tool', turn: 1, step: 1, title: 'Slow', startedAt: 1_200, completedAt: 2_200 })
    const fast = node({ key: 'fast', kind: 'tool', turn: 1, step: 1, title: 'Fast', startedAt: 2_300, completedAt: 2_500 })
    const model = new TrajectoryModel([turn, step, slow, fast])

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

  it('measures pending records from the render clock without inventing completed timing', () => {
    const pending: TrajectoryNode = {
      key: 'pending',
      kind: 'tool',
      title: 'Pending',
      status: 'pending',
      startedAt: 2_000,
    }
    const informational: TrajectoryNode = {
      key: 'info',
      kind: 'event',
      title: 'Info',
      status: 'info',
      startedAt: 2_000,
    }
    const measurement = new TrajectoryModel([pending, informational]).measure(2_750)

    expect(measurement.metrics.get('pending')?.durationMs).toBe(750)
    expect(measurement.metrics.get('info')?.durationMs).toBeUndefined()
  })
})
