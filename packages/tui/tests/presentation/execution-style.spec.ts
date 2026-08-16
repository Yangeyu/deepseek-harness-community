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
    expect(formatExecutionDuration(65_000, 'compact')).toBe('1m05s')
    expect(formatExecutionDuration(4_999, 'elapsed')).toBe('4s')
  })

  it('preserves manual Activity disclosure through child prepend and append', () => {
    const disclosure = new ExecutionDisclosureState()
    disclosure.observeActivity(['tool:read'], 'running')
    disclosure.toggleActivity(['tool:read'], false)

    disclosure.observeActivity(['thought:1:1', 'tool:read', 'tool:test'], 'running')

    expect(disclosure.activityExpanded(['thought:1:1', 'tool:read', 'tool:test'], false)).toBe(true)
  })

  it('automatically discloses a failure once without overriding manual collapse', () => {
    const disclosure = new ExecutionDisclosureState()
    disclosure.observeActivity(['tool:test'], 'failed')
    expect(disclosure.activityExpanded(['tool:test'], false)).toBe(true)

    disclosure.toggleActivity(['tool:test'], false)
    disclosure.observeActivity(['tool:test'], 'failed')

    expect(disclosure.activityExpanded(['tool:test'], false)).toBe(false)
  })
})
