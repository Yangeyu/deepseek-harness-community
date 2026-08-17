import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { RenderedTextSelection } from '../../src/presentation/text-selection.ts'

describe('RenderedTextSelection', () => {
  it('extracts and highlights a forward multi-line selection', () => {
    const selection = new RenderedTextSelection()
    const lines = ['alpha beta', 'gamma delta']

    selection.begin({ row: 0, col: 6 })
    expect(selection.update({ row: 1, col: 4 })).toBe(true)
    expect(selection.finish({ row: 1, col: 4 }, lines)).toEqual({
      kind: 'selection',
      changed: false,
      text: 'beta\ngamma',
    })

    const rendered = selection.apply(lines)
    expect(rendered.join('\n')).toContain('\u001b[7m')
    expect(stripTerminalSequences(rendered.join('\n'))).toBe(lines.join('\n'))
  })

  it('normalizes reverse selection and excludes trailing layout padding', () => {
    const selection = new RenderedTextSelection()
    const lines = ['first   ', 'second   ']

    selection.begin({ row: 1, col: 5 })
    expect(selection.finish({ row: 0, col: 0 }, lines)).toEqual({
      kind: 'selection',
      changed: true,
      text: 'first\nsecond',
    })
  })

  it('selects whole wide graphemes without leaking ANSI styling', () => {
    const selection = new RenderedTextSelection()
    const lines = ['\u001b[31mA你B\u001b[39m']

    selection.begin({ row: 0, col: 1 })
    expect(selection.finish({ row: 0, col: 3 }, lines)).toEqual({
      kind: 'selection',
      changed: true,
      text: '你B',
    })
    const rendered = selection.apply(lines)[0] ?? ''
    expect(rendered).toContain('\u001b[7m')
    expect(stripTerminalSequences(rendered)).toBe('A你B')
  })

  it('returns a click when press and release do not form text', () => {
    const selection = new RenderedTextSelection()
    selection.begin({ row: 0, col: 2 })
    expect(selection.finish({ row: 0, col: 2 }, ['text'])).toEqual({
      kind: 'click',
      changed: false,
    })
    expect(selection.apply(['text'])).toEqual(['text'])
  })

  it('does not turn a drag across blank cells into a block click', () => {
    const selection = new RenderedTextSelection()
    selection.begin({ row: 0, col: 0 })
    expect(selection.finish({ row: 0, col: 2 }, ['   '])).toEqual({
      kind: 'selection',
      changed: true,
      text: '',
    })
  })

  it('reapplies selection highlighting after embedded SGR resets', () => {
    const selection = new RenderedTextSelection()
    const lines = ['a\u001b[31mb\u001b[0mc']
    selection.begin({ row: 0, col: 0 })
    selection.update({ row: 0, col: 2 })

    expect(selection.apply(lines)[0]).toContain('\u001b[0m\u001b[7m')
  })
})
