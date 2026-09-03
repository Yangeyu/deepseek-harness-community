import {
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui'

interface TextPoint {
  row: number
  col: number
}

interface TextRange {
  start: TextPoint
  end: TextPoint
}

export type TextSelectionRelease =
  | { kind: 'none'; changed: false }
  | { kind: 'click'; changed: boolean }
  | { kind: 'selection'; changed: boolean; text: string }

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const SELECT_START = '\u001b[7m'
const SELECT_END = '\u001b[27m'
// oxlint-disable-next-line no-control-regex -- SGR codes must be preserved inside highlighted text.
const SGR = /\u001b\[[0-?]*[ -/]*m/g

function samePoint(left: TextPoint, right: TextPoint): boolean {
  return left.row === right.row && left.col === right.col
}

function before(left: TextPoint, right: TextPoint): boolean {
  return left.row < right.row || (left.row === right.row && left.col < right.col)
}

function graphemeCellRange(line: string, column: number): { start: number; end: number } | undefined {
  let current = 0
  for (const { segment } of graphemes.segment(stripTerminalSequences(line))) {
    const width = visibleWidth(segment)
    if (width > 0 && column >= current && column < current + width) {
      return { start: current, end: current + width }
    }
    current += width
  }
  return undefined
}

function selectionColumns(line: string, row: number, range: TextRange): { start: number; end: number } {
  const lineWidth = visibleWidth(line)
  const start = row === range.start.row
    ? graphemeCellRange(line, range.start.col)?.start ?? Math.min(range.start.col, lineWidth)
    : 0
  const end = row === range.end.row
    ? graphemeCellRange(line, range.end.col)?.end ?? Math.min(range.end.col + 1, lineWidth)
    : lineWidth
  return { start: Math.max(0, start), end: Math.max(0, end) }
}

function highlight(text: string): string {
  return `${SELECT_START}${text.replace(SGR, code => `${code}${SELECT_START}`)}${SELECT_END}`
}

/** Character-cell selection over the latest rendered main-screen lines. */
export class RenderedTextSelection {
  private anchor: TextPoint | undefined
  private focus: TextPoint | undefined
  private pressActive = false

  begin(point: TextPoint): boolean {
    this.anchor = point
    this.focus = point
    this.pressActive = true
    return true
  }

  update(point: TextPoint): boolean {
    if (!this.pressActive || this.focus === undefined || samePoint(this.focus, point)) return false
    this.focus = point
    return true
  }

  finish(point: TextPoint, lines: readonly string[]): TextSelectionRelease {
    if (!this.pressActive) return { kind: 'none', changed: false }
    const changed = this.update(point)
    this.pressActive = false
    const range = this.range()
    if (range === undefined) {
      this.anchor = undefined
      this.focus = undefined
      return { kind: 'click', changed }
    }
    return { kind: 'selection', changed, text: this.extract(lines, range) }
  }

  clear(): boolean {
    const changed = this.anchor !== undefined || this.focus !== undefined || this.pressActive
    this.anchor = undefined
    this.focus = undefined
    this.pressActive = false
    return changed
  }

  apply(lines: readonly string[]): string[] {
    const range = this.range()
    if (range === undefined) return [...lines]
    return lines.map((line, row) => {
      if (row < range.start.row || row > range.end.row) return line
      const columns = selectionColumns(line, row, range)
      if (columns.end <= columns.start) return line
      const lineWidth = visibleWidth(line)
      const beforeSelection = sliceByColumn(line, 0, columns.start, true)
      const selection = sliceByColumn(line, columns.start, columns.end - columns.start, true)
      const afterSelection = sliceByColumn(line, columns.end, lineWidth - columns.end, true)
      return `${beforeSelection}${highlight(selection)}${afterSelection}`
    })
  }

  private range(): TextRange | undefined {
    if (this.anchor === undefined || this.focus === undefined || samePoint(this.anchor, this.focus)) {
      return undefined
    }
    return before(this.anchor, this.focus)
      ? { start: this.anchor, end: this.focus }
      : { start: this.focus, end: this.anchor }
  }

  private extract(lines: readonly string[], range: TextRange): string {
    const selected: string[] = []
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      const line = lines[row] ?? ''
      const columns = selectionColumns(line, row, range)
      selected.push(stripTerminalSequences(
        sliceByColumn(line, columns.start, columns.end - columns.start, true),
      ).trimEnd())
    }
    return selected.join('\n')
  }
}
