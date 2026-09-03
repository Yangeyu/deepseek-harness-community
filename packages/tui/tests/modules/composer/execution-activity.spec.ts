import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../../src/runtime/session/contracts.ts'
import { buildExecutionSnapshot } from '../../../src/runtime/execution/projection/index.ts'
import { previousTurnDuration } from '../../../src/modules/composer/execution-activity.ts'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/manager.ts'

function stateWith(values: readonly unknown[], sessionRunning = false): RuntimeSessionSnapshot {
  return {
    execution: buildExecutionSnapshot({
      sessionId: 'session-test',
      epoch: 0,
      entries: values as readonly HistoryEntry[],
      sessionRunning,
    }),
  } as RuntimeSessionSnapshot
}

const started = (turn: number, time: number) => ({ event: { type: 'turn/start', seq: turn, time, data: { turn } } })
const ended = (turn: number, time: number) => ({
  event: { type: 'turn/end', seq: turn + 100, time, data: { turn, reason: { kind: 'completed' } } },
})

describe('previous turn duration', () => {
  it('measures the cumulative elapsed duration of the last settled turn subtree', () => {
    const state = stateWith([
      started(1, 1_000),
      ended(1, 12_400),
      started(2, 20_000),
      { event: { type: 'step/start', seq: 3, time: 21_000, data: { turn: 2, step: 1 } } },
      { event: { type: 'step/end', seq: 4, time: 85_000, data: { turn: 2, step: 1, reason: { kind: 'completed' } } } },
      ended(2, 86_000),
    ])

    expect(previousTurnDuration(state)).toBe(66_000)
  })

  it('returns undefined without a settled turn', () => {
    expect(previousTurnDuration(stateWith([]))).toBeUndefined()
    expect(previousTurnDuration(stateWith([
      started(1, 1_000),
      { event: { type: 'turn/end', seq: 2, time: 5_000, data: { turn: 1, reason: { kind: 'interrupted' } } } },
    ]))).toBe(4_000)
    expect(previousTurnDuration(stateWith([started(1, 1_000)], true))).toBeUndefined()
  })
})
