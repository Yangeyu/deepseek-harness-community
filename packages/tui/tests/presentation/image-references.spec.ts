import {
  stripTerminalSequences,
  type TUI,
} from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { paintImageReferences } from '../../src/presentation/image-references.ts'
import { InlineReferenceEditor } from '../../src/presentation/inline-reference-editor.ts'
import { createTheme } from '../../src/presentation/theme.ts'

function referenceEditor(references: readonly string[] = ['[Image #1]']): {
  editor: InlineReferenceEditor
  theme: ReturnType<typeof createTheme>
} {
  const theme = createTheme(true)
  const tui = {
    terminal: { rows: 24 },
    requestRender: vi.fn(),
  } as unknown as TUI
  return {
    editor: new InlineReferenceEditor(
      tui,
      theme.editor,
      () => references,
      theme.imageReference,
    ),
    theme,
  }
}

describe('inline image reference presentation', () => {
  it('paints references in place without changing the durable text', () => {
    const rendered = paintImageReferences(
      'first [Image #2] then [Image #1]',
      text => `<text>${text}</text>`,
      text => `<image>${text}</image>`,
    )

    expect(rendered).toBe('<text>first </text><image>[Image #2]</image><text> then </text><image>[Image #1]</image>')
    expect(rendered.replaceAll(/<\/?(?:text|image)>/gu, ''))
      .toBe('first [Image #2] then [Image #1]')
  })

  it('uses the shared reference style for registered Editor markers', () => {
    const { editor, theme } = referenceEditor()
    editor.setText('before [Image #1] after')

    const rendered = editor.render(80).join('\n')
    expect(rendered).toContain(theme.imageReference('[Image #1]'))
    expect(stripTerminalSequences(rendered)).toContain('before [Image #1] after')
  })

  it('keeps a registered reference together and highlighted at a wrap boundary', () => {
    const { editor, theme } = referenceEditor()
    editor.setText('123456789 [Image #1] after')

    const rendered = editor.render(20)

    expect(rendered.join('\n')).toContain(theme.imageReference('[Image #1]'))
    expect(rendered.map(stripTerminalSequences)).toContain('[Image #1] after    ')
    expect(editor.getExpandedText()).toBe('123456789 [Image #1] after')
    expect(editor.getLines()).toEqual(['123456789 [Image #1] after'])
  })

  it('keeps the reference style active when the cursor is at its first character', () => {
    const { editor, theme } = referenceEditor()
    editor.setText('[Image #1]')
    editor.handleInput('\u001b[D')

    const rendered = editor.render(20).join('\n')

    expect(editor.getCursor()).toEqual({ line: 0, col: 0 })
    expect(rendered).toContain(theme.imageReference('['))
    expect(rendered).toContain(theme.imageReference('Image #1]'))
    expect(stripTerminalSequences(rendered)).toContain('[Image #1]')
  })

  it('deletes the exact reference adjacent to either side of the cursor', () => {
    const { editor } = referenceEditor()
    editor.setText('[Image #1] x [Image #1]')

    editor.handleInput('\u007F')

    expect(editor.getExpandedText()).toBe('[Image #1] x ')
    expect(editor.getCursor()).toEqual({ line: 0, col: '[Image #1] x '.length })
    editor.handleInput('\u001F')
    expect(editor.getExpandedText()).toBe('[Image #1] x [Image #1]')

    editor.handleInput('\u001b[D')
    expect(editor.getCursor()).toEqual({ line: 0, col: '[Image #1] x '.length })
    editor.handleInput('\u001b[3~')
    expect(editor.getExpandedText()).toBe('[Image #1] x ')
    expect(editor.getCursor()).toEqual({ line: 0, col: '[Image #1] x '.length })
  })
})
