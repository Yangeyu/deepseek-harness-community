import { visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { ComposerEditorFrame } from '../../src/presentation/composer-editor.ts'

class FakeEditor implements Component {
  constructor(private readonly suggestions: readonly string[] = []) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [
      '─'.repeat(width),
      ` draft${' '.repeat(Math.max(0, width - 6))}`,
      '─'.repeat(width),
      ...this.suggestions.map(suggestion => (
        suggestion + ' '.repeat(Math.max(0, width - visibleWidth(suggestion)))
      )),
    ]
  }
}

describe('ComposerEditorFrame', () => {
  it('places autocomplete before the Editor frame', () => {
    const frame = new ComposerEditorFrame(new FakeEditor(['README.md', 'read-model.ts']))

    expect(frame.render(24).map(line => line.trimEnd())).toEqual([
      'README.md',
      'read-model.ts',
      '─'.repeat(24),
      ' draft',
      '─'.repeat(24),
    ])
  })

  it('does not reserve synthetic prefix width', () => {
    const frame = new ComposerEditorFrame(new FakeEditor())

    expect(frame.render(24)).toEqual([
      '─'.repeat(24),
      ` draft${' '.repeat(18)}`,
      '─'.repeat(24),
    ])
  })
})
