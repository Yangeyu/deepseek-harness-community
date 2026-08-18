import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { AttachmentDraft } from '../application/attachments/drafts.ts'
import type { TuiTheme } from './theme.ts'
import { sanitizeTerminalText } from '../text.ts'

function sizeLabel(bytes: number): string {
  return bytes < 1_024 * 1_024
    ? `${Math.max(1, Math.round(bytes / 1_024))} KB`
    : `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

/** Fixed composer rail for local image drafts; never scrolls into transcript history. */
export class AttachmentRail implements Component {
  private drafts: readonly AttachmentDraft[] = []
  private index = 0

  constructor(
    private readonly theme: TuiTheme,
    private readonly onRemove?: (index: number) => void,
    private readonly onExit?: () => void,
  ) {}

  setDrafts(drafts: readonly AttachmentDraft[]): void {
    this.drafts = drafts
    this.index = Math.min(this.index, Math.max(0, drafts.length - 1))
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.onExit?.()
    if (matchesKey(data, Key.left) || data === 'h') this.index = Math.max(0, this.index - 1)
    else if (matchesKey(data, Key.right) || data === 'l') this.index = Math.min(this.drafts.length - 1, this.index + 1)
    else if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) this.onRemove?.(this.index)
  }
  invalidate(): void {}

  render(width: number): string[] {
    if (this.drafts.length === 0) return []
    const visible = this.drafts.slice(0, 2)
    const cards = visible.map((draft, index) => {
      const state = draft.error === undefined ? '' : this.theme.warning(' · failed')
      const name = [...sanitizeTerminalText(draft.name)]
      const shortName = name.length <= 24 ? name.join('') : `${name.slice(0, 11).join('')}…${name.slice(-12).join('')}`
      const dimensions = draft.width === undefined || draft.height === undefined ? '' : ` · ${String(draft.width)}×${String(draft.height)}`
      const card = `${this.theme.imageReference(draft.placeholder)} ${shortName} ${this.theme.dim(`${sizeLabel(draft.data.byteLength)}${dimensions}`)}${state}`
      return index === this.index ? this.theme.bold(card) : card
    })
    const overflow = this.drafts.length > visible.length
      ? `+${String(this.drafts.length - visible.length)} images · `
      : ''
    const error = this.drafts.find(draft => draft.error !== undefined)?.error
    return [
      truncateToWidth(`${this.theme.accent('Image')}  ${cards.join('   ')}`, Math.max(1, width)),
      truncateToWidth(error === undefined
        ? this.theme.dim(`${overflow}Alt+A manage · Ctrl+V paste · Alt+Backspace remove latest`)
        : this.theme.warning(sanitizeTerminalText(error)), Math.max(1, width)),
    ]
  }
}
