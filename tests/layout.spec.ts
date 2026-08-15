import { describe, expect, it } from 'vitest'
import { anchorComposer } from '../src/layout.ts'

describe('anchorComposer', () => {
  it('pins the composer to the bottom of a short viewport', () => {
    const lines = anchorComposer(['header', '', 'message'], ['status', 'editor', 'footer'], 12)

    expect(lines).toHaveLength(12)
    expect(lines.slice(-3)).toEqual(['status', 'editor', 'footer'])
  })

  it('preserves scrollback content after it exceeds the viewport', () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)
    const lines = anchorComposer(content, ['editor', 'footer'], 8)

    expect(lines).toEqual([...content, '', 'editor', 'footer'])
  })
})
