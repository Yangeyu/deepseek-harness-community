import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { TextDocument } from '../../../src/presentation/primitives/text-document.ts'

describe('TextDocument', () => {
  it('pages forwards and backwards through sparse checkpoints without losing rows', () => {
    const lines = Array.from({ length: 512 }, (_, index) => `row ${String(index)}`)
    const document = new TextDocument(lines.join('\n'))
    for (const top of [0, 129, 300, 480, 900, 256, 127, 0]) {
      const window = document.read(20, top, 17)
      expect(window.lines).toEqual(lines.slice(window.top, window.top + 17))
      expect(window.top).toBe(Math.min(top, lines.length - 17))
    }
    expect(document.read(20, 500, 17).totalRows).toBe(512)
  })

  it('visits only a window of a huge single line and reflows it on width change', () => {
    const document = new TextDocument('x'.repeat(1_000_000))
    const first = document.read(80, 0, 24)
    expect(first.lines).toEqual(Array<string>(24).fill('x'.repeat(80)))
    expect(first.totalRows).toBeUndefined()
    expect(first.hasMore).toBe(true)
    expect(document.read(80, 1, 24).lines).toEqual(first.lines)
    expect(document.read(40, 0, 3).lines).toEqual(Array<string>(3).fill('x'.repeat(40)))
  })

  it('wraps graphemes rather than UTF-16 units and keeps blank logical lines', () => {
    const text = '中文👩‍💻é\n\n尾部\n'
    const document = new TextDocument(text)
    const result = document.read(4, 0, 20)
    expect(result.lines).toEqual(['中文', '👩‍💻é', '', '尾部', ''])
    expect(result.lines.every(line => visibleWidth(line) <= 4)).toBe(true)
    expect(result.totalRows).toBe(5)
    expect(result.hasMore).toBe(false)
  })

  it('locates and highlights raw multiline matches through wrapping and sanitization', () => {
    const text = 'ab\tc\u0000d\r\nef\u001bgHI\rEND'
    const document = new TextDocument(text)
    const highlight = { start: text.indexOf('c'), end: text.indexOf('I'), paint: (value: string) => `[${value}]` }
    expect(document.locate(4, highlight.start)).toBe(1)
    const plain = document.read(4, 0, 20)
    expect(plain.lines).toEqual(['ab  ', '  cd', 'efgH', 'I', 'END'])
    expect(document.read(4, 0, 20, highlight)).toEqual({
      ...plain, lines: ['ab  ', '  [cd]', '[efgH]', 'I', 'END'],
    })
    // Painting never changes the cached plain viewport or its window metadata.
    expect(document.read(4, 0, 20)).toEqual(plain)
    expect(document.read(4, 1, 2, { ...highlight, paint: value => `<${value}>` }).lines)
      .toEqual(['  <cd>', '<efgH>'])
    expect(document.locate(3, highlight.start)).toBe(2)
    expect(document.read(3, 0, 20, highlight).lines).toEqual(['ab ', '   ', '[cd]', '[efg]', '[H]I', 'END'])
  })

  it('keeps combining and emoji graphemes intact when raw matches split them', () => {
    const text = 'Aé👩‍💻中Z'
    const document = new TextDocument(text)
    const paint = (value: string) => `[${value}]`
    expect(document.locate(3, text.indexOf('́'))).toBe(0)
    expect(document.locate(3, text.indexOf('💻'))).toBe(1)
    expect(document.locate(3, text.indexOf('中'))).toBe(2)
    expect(document.read(3, 0, 10, {
      start: text.indexOf('́'), end: text.indexOf('中'), paint,
    }).lines).toEqual(['A[é]', '[👩‍💻]', '中Z'])
    expect(document.locate(1, text.indexOf('💻'))).toBe(2)
    expect(document.read(1, 0, 10, {
      start: text.indexOf('💻'), end: text.indexOf('中') + 1, paint,
    }).lines).toEqual(['A', 'é', '[…]', '[…]', 'Z'])
  })

  it('locates distant matches through shared checkpoints and paints scrolling windows', () => {
    const text = Array.from({ length: 600 }, (_, index) => `${String(index).padStart(3, '0')}\txx`).join('\r\n')
    const document = new TextDocument(text)
    const paint = (value: string) => `[${value}]`
    for (const index of [400, 599, 128, 0, 450]) {
      const start = index * 8
      const highlight = { start, end: start + 6, paint }
      const top = document.locate(4, start)
      expect(top).toBe(index * 3)
      expect(document.read(4, top, 2, highlight).lines).toEqual([`[${String(index).padStart(3, '0')} ]`, '[   x]'])
      expect(document.read(4, top + 1, 2, highlight).lines).toEqual(['[   x]', '[x]'])
    }
    expect(document.locate(4, text.length)).toBe(1799)
    expect(document.locate(20, text.length)).toBe(599)
  })

  it('does not invent a row when EOF lands exactly on a checkpoint boundary', () => {
    const document = new TextDocument(Array<string>(128).fill('value').join('\n'))
    expect(document.read(10, 95, 1).lines).toEqual(['value'])
    const last = document.read(10, 128, 1)
    expect(last).toEqual({ lines: ['value'], top: 127, totalRows: 128, hasMore: false })
  })
})
