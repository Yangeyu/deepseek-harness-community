import { CURSOR_MARKER, Editor, stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { ComposerEditorFrame } from '../../../../src/modules/composer/view/editor-frame.ts'
import { ComposerSparkle } from '../../../../src/modules/composer/view/sparkle.ts'
import { createTheme } from '../../../../src/presentation/primitives/theme.ts'

function fixture(color = false) {
  const theme = createTheme(color)
  const editor = new Editor({ terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI, theme.editor, { paddingX: 0 })
  editor.focused = true
  const sparkle = new ComposerSparkle({ enabled: false, visible: () => true, invalidate: vi.fn() })
  return { editor, theme, sparkle, frame: new ComposerEditorFrame(editor, theme, sparkle) }
}

describe('ComposerEditorFrame', () => {
  it('renders a padded card with a prompt and an empty-draft placeholder at the cursor', () => {
    const { frame } = fixture()
    const lines = frame.render(24)
    expect(lines.map(line => stripTerminalSequences(line).trimEnd())).toEqual(['', '› Ask anything', ''])
    expect(lines[1]).toContain(`${CURSOR_MARKER}Ask anything`)
    expect(lines[1]).not.toContain('\u001b[7m')
    expect(lines.map(visibleWidth)).toEqual([24, 24, 24])
  })

  it('keeps autocomplete above the card and aligned with the draft', () => {
    const { theme, sparkle } = fixture()
    const editor = {
      getText: () => 'draft',
      invalidate() {},
      render: (width: number) => ['─'.repeat(width), 'draft', '─'.repeat(width), 'README.md', 'read-model.ts'],
    }
    const frame = new ComposerEditorFrame(editor, theme, sparkle)
    expect(frame.render(24).map(line => line.trimEnd())).toEqual([
      '  README.md', '  read-model.ts', '', '› draft', '',
    ])
  })

  it('preserves wrapped Unicode input and the cursor in narrow terminals', () => {
    const { editor, frame } = fixture()
    editor.setText('中文 hello 👋 world')
    for (const width of [8, 12, 24]) {
      const lines = frame.render(width)
      expect(lines.every(line => visibleWidth(line) === width)).toBe(true)
      expect(lines.join('\n')).toContain(CURSOR_MARKER)
    }
    expect(editor.getText()).toBe('中文 hello 👋 world')
  })

  it('uses a native insertion position at the end and over a wide character without a software block', () => {
    const { editor, frame } = fixture()
    editor.setText('hi 中')
    expect(frame.render(24)[1]).toContain(`hi 中${CURSOR_MARKER} `)
    editor.handleInput('\u001b[D')
    const lines = frame.render(24)
    expect(lines[1]).toContain(`hi ${CURSOR_MARKER}中`)
    expect(lines.join('\n')).not.toContain('\u001b[7m')
    expect(lines.map(visibleWidth)).toEqual([24, 24, 24])
  })

  it('blends the card into light and dark terminal backgrounds, retaining it across text style resets', () => {
    const { frame, theme } = fixture(true)
    theme.terminalBackground = { r: 255, g: 255, b: 255 }
    expect(frame.render(24).every(line => line.startsWith('\u001b[48;2;244;244;244m'))).toBe(true)
    theme.terminalBackground = { r: 0, g: 0, b: 0 }
    const lines = frame.render(24)
    expect(lines.every(line => line.startsWith('\u001b[48;2;30;30;30m'))).toBe(true)
    expect(lines[1]).toContain('\u001b[22m\u001b[48;2;30;30;30m')
  })
})
