import { describe, expect, it } from 'vitest'
import { ExecutionDisclosureState } from '../../../src/modules/transcript/execution-presentation.ts'

describe('transcript execution presentation', () => {
  it('preserves manual Activity disclosure through child prepend and append', () => {
    const disclosure = new ExecutionDisclosureState()
    disclosure.toggleActivity(['tool:read'], false)

    expect(disclosure.activityExpanded(['thought:1:1', 'tool:read', 'tool:test'], false)).toBe(true)
  })
})
