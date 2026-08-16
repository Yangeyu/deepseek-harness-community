import {
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
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

function markerLabel(count: number): string {
  return Array.from({ length: count }, (_, index) => `[Image #${String(index + 1)}]`).join(' ')
}

function isEditorBorder(line: string): boolean {
  return stripTerminalSequences(line).startsWith('─')
}

/** Renders attachment tokens inside the Editor frame while keeping binary drafts out of editable text. */
export class AttachmentComposerFrame implements Component {
  private drafts: readonly AttachmentDraft[] = []

  constructor(
    private readonly editor: Component,
    private readonly theme: TuiTheme,
  ) {}

  setDrafts(drafts: readonly AttachmentDraft[]): void {
    this.drafts = drafts
  }

  handleInput(data: string): void {
    this.editor.handleInput?.(data)
  }

  invalidate(): void {
    this.editor.invalidate()
  }

  render(width: number): string[] {
    if (this.drafts.length === 0 || width < 8) return this.editor.render(width)
    const available = Math.min(Math.floor(width * 0.55), width - 4)
    const token = truncateToWidth(markerLabel(this.drafts.length), Math.max(1, available), '…')
    const prefix = this.theme.tool(token)
    const prefixWidth = visibleWidth(prefix)
    const innerWidth = Math.max(1, width - prefixWidth)
    const lines = this.editor.render(innerWidth)
    const emptyPrefix = ' '.repeat(prefixWidth)
    const borderPrefix = this.theme.editor.borderColor('─'.repeat(prefixWidth))
    let contentStarted = false
    let contentEnded = false

    return lines.map((line, index) => {
      if (index === 0) return `${borderPrefix}${line}`
      if (!contentEnded && isEditorBorder(line)) {
        contentEnded = true
        return `${borderPrefix}${line}`
      }
      if (contentEnded) return `${emptyPrefix}${line}`
      if (!contentStarted) {
        contentStarted = true
        return `${prefix}${line}`
      }
      return `${emptyPrefix}${line}`
    })
  }
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
      const card = `[${String(index + 1)}] ${shortName} ${this.theme.dim(`${sizeLabel(draft.data.byteLength)}${dimensions}`)}${state}`
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
