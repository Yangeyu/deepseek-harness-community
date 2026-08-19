import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import { buildLifecycleSnapshot } from '../../src/runtime/lifecycle/index.ts'
import { previousTurnDuration } from '../../src/presentation/composer-activity.ts'
import type { TuiState } from '../../src/runtime/controller.ts'

function stateWith(values: readonly unknown[], sessionRunning = false): TuiState {
  return {
    lifecycle: buildLifecycleSnapshot({
      sessionId: 'session-test',
      generation: 0,
      entries: values as readonly HistoryEntry[],
      sessionRunning,
    }),
  } as TuiState
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