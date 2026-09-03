import { describe, expect, it } from 'vitest'
import { formatDuration } from '../../../src/presentation/primitives/duration.ts'

describe('execution presentation policy', () => {
  it('formats one duration through surface-specific density variants', () => {
    expect(formatDuration(700)).toBe('700ms')
    expect(formatDuration(700, 'detail')).toBe('700 ms')
    expect(formatDuration(1_500, 'compact')).toBe('1.5s')
    expect(formatDuration(4_999, 'elapsed')).toBe('4s')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(75_000)).toBe('1m 15s')
    expect(formatDuration(65_000, 'compact')).toBe('1m 05s')
    expect(formatDuration(65_000, 'detail')).toBe('1m 05s')
    expect(formatDuration(65_000, 'elapsed')).toBe('1m 05s')
    expect(formatDuration(184_000, 'elapsed')).toBe('3m 04s')
    expect(formatDuration(3_600_000, 'elapsed')).toBe('60m 00s')
  })
})
