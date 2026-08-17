import { visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { AttachmentDraft } from '../../src/application/attachments/drafts.ts'
import { ComposerEditorFrame } from '../../src/presentation/composer-editor.ts'
import { createTheme } from '../../src/presentation/theme.ts'

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

function draft(id: string): AttachmentDraft {
  return {
    id,
    name: `${id}.png`,
    mediaType: 'image/png',
    data: Uint8Array.from([1]),
    source: 'clipboard',
  }
}

describe('ComposerEditorFrame', () => {
  it('places autocomplete before the Editor frame', () => {
    const frame = new ComposerEditorFrame(new FakeEditor(['README.md', 'read-model.ts']), createTheme(false))

    expect(frame.render(24).map(line => line.trimEnd())).toEqual([
      'README.md',
      'read-model.ts',
      '─'.repeat(24),
      ' draft',
      '─'.repeat(24),
    ])
  })

  it('keeps image markers inside the Editor while autocomplete remains above it', () => {
    const frame = new ComposerEditorFrame(new FakeEditor(['README.md']), createTheme(false))
    frame.setDrafts([draft('one'), draft('two')])

    const output = frame.render(48)

    expect(output[0]).toContain('README.md')
    expect(output[2]).toContain('[Image #1] [Image #2]')
    expect(output[2]).toContain('draft')
    expect(output.every(line => visibleWidth(line) === 48)).toBe(true)
  })

  it('does not reserve marker width when there are no images', () => {
    const frame = new ComposerEditorFrame(new FakeEditor(), createTheme(false))

    expect(frame.render(24)).toEqual([
      '─'.repeat(24),
      ` draft${' '.repeat(18)}`,
      '─'.repeat(24),
    ])
  })
})
