import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalLine } from '../../presentation/primitives/text.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import type { PendingInputItem } from './model.ts'

const DEFAULT_MAX_ROWS = 8
const MAX_PREVIEW_CHARACTERS = 4096
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Pure presentation of the parent's pending-input projection, never an input queue. */
export class PendingInputPreview implements Component {
  private items: readonly PendingInputItem[] = []

  constructor(private readonly theme: TuiTheme) {}

  setItems(items: readonly PendingInputItem[]): void {
    this.items = items
  }

  invalidate(): void {
    // No retained rendering or wrapped-body cache to invalidate.
  }

  render(width: number, maxRows = DEFAULT_MAX_ROWS): string[] {
    const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
    const budget = Number.isNaN(maxRows) ? 0 : Math.max(0, Math.min(DEFAULT_MAX_ROWS, Math.floor(maxRows)))
    if (columns === 0 || budget === 0 || this.items.length === 0) return []

    const steering = this.items.reduce((count, item) => count + Number(item.kind === 'steering'), 0)
    const queued = this.items.length - steering
    if (budget === 1) {
      const summary = `• Steering ${steering} · Queued ${queued}`
      const compact = `S:${steering} Q:${queued}`
      return [this.theme.secondary(truncateToWidth(visibleWidth(summary) <= columns ? summary : compact, columns, '…'))]
    }

    const groups = [
      { kind: 'steering', title: 'Steering', timing: 'before the next step', count: steering, rows: 1 },
      { kind: 'queued', title: 'Queued', timing: 'after this turn', count: queued, rows: 1 },
    ].filter(group => group.count > 0)

    // Reserve each title first, then share body rows fairly; a short group returns
    // its unused share to the other group. Every item uses exactly one preview row.
    let remaining = budget - groups.length
    while (remaining > 0) {
      let allocated = false
      for (const group of groups) {
        if (remaining === 0) break
        if (group.rows > group.count) continue
        group.rows++
        remaining--
        allocated = true
      }
      if (!allocated) break
    }

    const lines: string[] = []
    for (const group of groups) {
      const shown = group.rows - 1
      const hidden = group.count - shown
      // Hidden counts precede timing so they survive ordinary narrow layouts.
      const omission = hidden > 0 ? ` · ${hidden} hidden` : ''
      const heading = this.theme.secondary(`• ${group.title}`)
        + this.theme.dim(`${omission} · ${group.timing}`)
      lines.push(truncateToWidth(heading, columns, '…'))
      let rendered = 0
      for (const item of this.items) {
        if (rendered === shown) break
        if (item.kind !== group.kind) continue
        lines.push(this.theme.dim(truncateToWidth(`  ↳ ${previewText(item.text)}`, columns, '…')))
        rendered++
      }
    }
    return lines
  }
}

/** Bound work before sanitizing; flatten multiline bodies without building wrapped rows. */
function previewText(text: string): string {
  const clipped = text.length > MAX_PREVIEW_CHARACTERS
  let prefix = text.slice(0, MAX_PREVIEW_CHARACTERS)
  if (clipped) {
    // The final grapheme may continue outside the source window (surrogate pair,
    // combining marks, or ZWJ sequence), so omit it rather than display a fragment.
    let lastBoundary = 0
    for (const segment of graphemes.segment(prefix)) lastBoundary = segment.index
    prefix = prefix.slice(0, lastBoundary)
  }
  const line = sanitizeTerminalLine(stripTerminalSequences(prefix))
  return `${line || '(empty)'}${clipped ? '…' : ''}`
}
