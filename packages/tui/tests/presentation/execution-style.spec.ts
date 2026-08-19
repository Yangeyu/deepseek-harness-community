import { describe, expect, it } from 'vitest'
import {
  ExecutionDisclosureState,
  formatExecutionDuration,
} from '../../src/presentation/execution-style.ts'

describe('execution presentation policy', () => {
  it('formats one duration through surface-specific density variants', () => {
    expect(formatExecutionDuration(700)).toBe('700ms')
    expect(formatExecutionDuration(700, 'detail')).toBe('700 ms')
    expect(formatExecutionDuration(1_500, 'compact')).toBe('1.5s')
    expect(formatExecutionDuration(4_999, 'elapsed')).toBe('4s')
    expect(formatExecutionDuration(12_400)).toBe('12s')
    expect(formatExecutionDuration(75_000)).toBe('1m 15s')
    expect(formatExecutionDuration(65_000, 'compact')).toBe('1m 05s')
    expect(formatExecutionDuration(65_000, 'detail')).toBe('1m 05s')
    expect(formatExecutionDuration(65_000, 'elapsed')).toBe('1m 05s')
    expect(formatExecutionDuration(184_000, 'elapsed')).toBe('3m 04s')
    expect(formatExecutionDuration(3_600_000, 'elapsed')).toBe('60m 00s')
  })

  it('preserves manual Activity disclosure through child prepend and append', () => {
    const disclosure = new ExecutionDisclosureState()
    disclosure.toggleActivity(['tool:read'], false)

    expect(disclosure.activityExpanded(['thought:1:1', 'tool:read', 'tool:test'], false)).toBe(true)
  })
})
