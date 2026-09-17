import { CURSOR_MARKER, Editor, stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerEditorFrame } from '../../../../src/modules/composer/view/editor-frame.ts'
import { ComposerSparkle } from '../../../../src/modules/composer/view/sparkle.ts'
import { createTheme } from '../../../../src/presentation/primitives/theme.ts'

afterEach(() => { vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  const theme = createTheme(true)
  const editor = new Editor({ terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI, theme.editor, { paddingX: 0 })
  editor.focused = true
  let visible = true
  const invalidate = vi.fn()
  const sparkle = new ComposerSparkle({ enabled: true, visible: () => visible, invalidate })
  const frame = new ComposerEditorFrame(editor, theme, sparkle)
  return { editor, frame, sparkle, invalidate, hide: () => { visible = false }, show: () => { visible = true } }
}

const stars = /[⠁⠂⠄⠈⠐⠠⡀⢀]/u

describe('ComposerSparkle', () => {
  it('keeps animating beyond 15 seconds while preserving Unicode text, the cursor and card geometry', () => {
    const { editor, frame, sparkle, invalidate } = fixture()
    editor.setText('中文 👋 hello')
    const first = frame.render(100)
    vi.advanceTimersByTime(30_000)
    const later = frame.render(100)
    expect(later).not.toEqual(first)
    expect(invalidate).toHaveBeenCalledOnce()
    for (const lines of [first, later]) {
      expect(lines.map(visibleWidth)).toEqual([100, 100, 100])
      expect(stripTerminalSequences(lines[1]!)).toContain('› 中文 👋 hello')
      expect(lines[1]).toContain(CURSOR_MARKER)
      expect(lines.join('\n')).toMatch(stars)
    }
    expect(editor.getText()).toBe('中文 👋 hello')
    sparkle.dispose()
    vi.advanceTimersByTime(150)
    expect(invalidate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('decorates interior blanks while preserving wide glyphs, styled spaces and the cursor', () => {
    const { sparkle } = fixture()
    const line = `中👩‍💻${CURSOR_MARKER} \u001b[7m   \u001b[0m\u001b[38;2;100;120;140m[Image #1]\u001b[39m${' '.repeat(80)}end`
    const [painted] = sparkle.render([line], {
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 30, g: 30, b: 30 },
    })
    expect(painted).toMatch(stars)
    // oxlint-disable-next-line no-control-regex -- Erase only the generated star cells to compare occupied bytes.
    expect(painted!.replace(/\u001b\[38;2;\d+;\d+;\d+m[⠁⠂⠄⠈⠐⠠⡀⢀]\u001b\[39m/gu, ' ')).toBe(line)
    expect(painted).toContain(`${CURSOR_MARKER} \u001b[7m   \u001b[0m`)
    expect(visibleWidth(painted!)).toBe(visibleWidth(line))
    sparkle.dispose()
  })

  it('pauses redraws while hidden and resumes without an expiry', () => {
    const { frame, sparkle, invalidate, hide, show } = fixture()
    frame.render(100)
    hide()
    vi.advanceTimersByTime(150)
    expect(invalidate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(frame.render(100).join('\n')).not.toMatch(stars)
    vi.advanceTimersByTime(60_000)
    show()
    expect(frame.render(100).join('\n')).toMatch(stars)
    vi.advanceTimersByTime(150)
    expect(invalidate).toHaveBeenCalledOnce()
    sparkle.dispose()
  })
})
