import { describe, expect, it } from 'vitest'
import { Text } from '@earendil-works/pi-tui'
import { anchorComposer, ComposerAnchoredLayout } from '../src/layout.ts'

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

  it('maps visible main-screen rows into transcript-relative rows', () => {
    const layout = new ComposerAnchoredLayout(
      new Text('header\ncontext', 0, 0),
      new Text('thought', 0, 0),
      new Text('status', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )

    expect(layout.transcriptRowAt(3, 0, 80)).toBe(0)
    expect(layout.transcriptRowAt(1, 5, 80)).toBe(3)
  })
})
