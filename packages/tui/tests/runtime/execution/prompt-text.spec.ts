import { describe, expect, it } from 'vitest'
import { promptTextFromContent } from '../../../src/runtime/execution/prompt-text.ts'

describe('durable Prompt text projection', () => {
  it('preserves text around images without inventing image positions', () => {
    expect(promptTextFromContent([
      { type: 'text', text: 'before [Image #1]' },
      { type: 'image' },
      { type: 'text', text: ' after' },
    ])).toBe('before [Image #1] after')
    expect(promptTextFromContent([
      { type: 'text', text: 'exact' },
      { type: 'image' },
    ])).toBe('exact')
    expect(promptTextFromContent([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])).toBe('first\nsecond')
  })
})
