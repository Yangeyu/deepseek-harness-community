import { visibleWidth } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from './text.ts'

const CHECKPOINT_ROWS = 128
const BUFFER_ROWS = 32
const BUFFER_CHARACTERS = 64 * 1024
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

interface Row {
  readonly text: string
  readonly offset: number
  readonly endOffset: number
  readonly nextOffset: number
  readonly final: boolean
}

export interface TextDocumentHighlight {
  /** Half-open UTF-16 offsets in the original, unsanitized text. */
  readonly start: number
  readonly end: number
  readonly paint: (text: string) => string
}

export interface TextDocumentWindow {
  readonly lines: readonly string[]
  readonly top: number
  /** Unknown until the final source row has actually been visited. */
  readonly totalRows: number | undefined
  readonly hasMore: boolean
}

/**
 * A terminal-safe plain-text document with sparse visual-row checkpoints.
 * Retains the source and a small viewport buffer, never all folded lines.
 * Indexing a previously unvisited distant position is linear in that prefix;
 * adjacent scrolling reuses the buffer/checkpoints. Width changes retire only
 * visual positions, not the source. Markdown is deliberately not interpreted.
 */
export class TextDocument {
  private readonly source: string
  private width = 0
  private checkpoints: Array<{ row: number; offset: number }> = [{ row: 0, offset: 0 }]
  private totalRows: number | undefined
  private buffer: { top: number; rows: Row[] } = { top: 0, rows: [] }
  // Only the active range boundaries, not a full-source character map.
  private readonly offsets = new Map<number, number>()

  constructor(private readonly raw: string) {
    this.source = sanitizeTerminalText(raw).replaceAll('\t', '    ')
  }

  /** Return the visual row containing a raw UTF-16 offset. EOF belongs to the last row. */
  locate(width: number, rawOffset: number): number {
    this.setWidth(width)
    const offset = this.sourceOffset(rawOffset, true)
    const checkpoint = this.checkpointAt(offset, 'offset')
    let row = checkpoint.row
    for (const next of this.rows(checkpoint.offset)) {
      this.remember(row, next)
      if (next.final || offset < next.nextOffset) return row
      row += 1
    }
    return row
  }

  read(width: number, top: number, count: number, highlight?: TextDocumentHighlight): TextDocumentWindow {
    this.setWidth(width)
    const rows = Math.max(0, Math.floor(count))
    let requestedTop = Math.max(0, Math.floor(top))
    if (this.totalRows !== undefined) requestedTop = Math.min(requestedTop, Math.max(0, this.totalRows - rows))
    if (rows === 0) return { lines: [], top: requestedTop, totalRows: this.totalRows, hasMore: this.totalRows === undefined || requestedTop < this.totalRows }
    this.prepare(requestedTop, rows)
    // Discovering EOF can clamp a requested page. Re-read near the end rather
    // than displaying a blank page or losing the last few lines.
    if (this.totalRows !== undefined) {
      const clamped = Math.min(requestedTop, Math.max(0, this.totalRows - rows))
      if (clamped !== requestedTop) {
        requestedTop = clamped
        this.prepare(requestedTop, rows)
      }
    }
    const start = highlight ? this.sourceOffset(highlight.start, true) : 0
    const end = highlight ? this.sourceOffset(highlight.end, false) : 0
    const lines = this.buffer.rows.slice(requestedTop - this.buffer.top, requestedTop - this.buffer.top + rows)
      .map(row => highlight && highlight.end > highlight.start && end > start
        ? this.paintRow(row, start, end, highlight.paint)
        : row.text)
    return {
      lines,
      top: requestedTop,
      totalRows: this.totalRows,
      hasMore: this.totalRows === undefined || requestedTop + lines.length < this.totalRows,
    }
  }

  private setWidth(width: number): void {
    const columns = Math.max(1, Math.floor(width))
    if (columns === this.width) return
    this.width = columns
    this.checkpoints = [{ row: 0, offset: 0 }]
    this.totalRows = undefined
    this.buffer = { top: 0, rows: [] }
  }

  private sourceOffset(rawOffset: number, start: boolean): number {
    let offset = Math.max(0, Math.min(this.raw.length, Math.floor(rawOffset)))
    // Both bytes of CRLF belong to its one normalized newline. A range ending
    // between them includes it; a range starting there still starts on it.
    if (start && this.raw[offset] === '\n' && this.raw[offset - 1] === '\r') offset -= 1
    const cached = this.offsets.get(offset)
    if (cached !== undefined) return cached
    const normalized = sanitizeTerminalText(this.raw.slice(0, offset)).replaceAll('\t', '    ').length
    if (this.offsets.size === 2) this.offsets.delete(this.offsets.keys().next().value!)
    this.offsets.set(offset, normalized)
    return normalized
  }

  private paintRow(row: Row, start: number, end: number, paint: (text: string) => string): string {
    if (row.endOffset <= start || row.offset >= end) return row.text
    let before = ''
    let selected = ''
    let after = ''
    // Regenerate only intersecting viewport rows, including the original
    // graphemes hidden behind width-one clipping. Cached rows stay plain.
    for (const { segment, index } of graphemes.segment(this.source.slice(row.offset, row.endOffset))) {
      const text = visibleWidth(segment) > this.width ? '…' : segment
      if (row.offset + index + segment.length <= start) before += text
      else if (row.offset + index < end) selected += text
      else after += text
    }
    return before + (selected ? paint(selected) : '') + after
  }

  private checkpointAt(position: number, field: 'row' | 'offset'): { row: number; offset: number } {
    let low = 0
    let high = this.checkpoints.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (this.checkpoints[middle]![field] <= position) low = middle
      else high = middle - 1
    }
    return this.checkpoints[low]!
  }

  private remember(row: number, next: Row): void {
    if (next.final) this.totalRows = row + 1
    else if ((row + 1) % CHECKPOINT_ROWS === 0 && row + 1 > this.checkpoints.at(-1)!.row) {
      this.checkpoints.push({ row: row + 1, offset: next.nextOffset })
    }
  }

  private prepare(top: number, count: number): void {
    const needed = this.totalRows === undefined ? top + count : Math.min(this.totalRows, top + count)
    if (top >= this.buffer.top && needed <= this.buffer.top + this.buffer.rows.length) return
    const checkpoint = this.checkpointAt(top, 'row')
    let row = checkpoint.row
    const rows: Row[] = []
    let characters = 0
    for (const next of this.rows(checkpoint.offset)) {
      if (row >= top) {
        rows.push(next)
        characters += next.text.length
      }
      this.remember(row, next)
      row += 1
      if (next.final || rows.length >= count + BUFFER_ROWS || (rows.length > count && characters >= BUFFER_CHARACTERS)) break
    }
    this.buffer = { top, rows }
  }

  private *rows(offset: number): Generator<Row> {
    const text = this.source.slice(offset)
    let line = ''
    let columns = 0
    let rowOffset = offset
    for (const { segment, index } of graphemes.segment(text)) {
      if (segment === '\n') {
        yield { text: line, offset: rowOffset, endOffset: offset + index, nextOffset: offset + index + 1, final: false }
        rowOffset = offset + index + 1
        line = ''
        columns = 0
        continue
      }
      const size = visibleWidth(segment)
      if (columns > 0 && columns + size > this.width) {
        yield { text: line, offset: rowOffset, endOffset: offset + index, nextOffset: offset + index, final: false }
        rowOffset = offset + index
        line = ''
        columns = 0
      }
      line += size > this.width ? '…' : segment
      columns += Math.min(size, this.width)
    }
    yield { text: line, offset: rowOffset, endOffset: this.source.length, nextOffset: this.source.length, final: true }
  }
}
