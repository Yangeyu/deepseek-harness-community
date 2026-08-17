import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { AttachmentDraft } from '../application/attachments/drafts.ts'
import type { TuiTheme } from './theme.ts'

interface EditorRender {
  autocomplete: string[]
  frame: string[]
}

function markerLabel(count: number): string {
  return Array.from({ length: count }, (_, index) => `[Image #${String(index + 1)}]`).join(' ')
}

function isEditorBorder(line: string): boolean {
  return stripTerminalSequences(line).startsWith('─')
}

function splitEditorRender(lines: string[]): EditorRender {
  const closingBorder = lines.findIndex((line, index) => index > 0 && isEditorBorder(line))
  if (closingBorder < 0 || closingBorder === lines.length - 1) {
    return { autocomplete: [], frame: lines }
  }
  return {
    autocomplete: lines.slice(closingBorder + 1),
    frame: lines.slice(0, closingBorder + 1),
  }
}

/** Keeps autocomplete above the bottom-anchored Editor and image markers inside its frame. */
export class ComposerEditorFrame implements Component {
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
    if (this.drafts.length === 0 || width < 8) {
      const rendered = splitEditorRender(this.editor.render(width))
      return [...rendered.autocomplete, ...rendered.frame]
    }

    const available = Math.min(Math.floor(width * 0.55), width - 4)
    const token = truncateToWidth(markerLabel(this.drafts.length), Math.max(1, available), '…')
    const prefix = this.theme.tool(token)
    const prefixWidth = visibleWidth(prefix)
    const emptyPrefix = ' '.repeat(prefixWidth)
    const borderPrefix = this.theme.editor.borderColor('─'.repeat(prefixWidth))
    const rendered = splitEditorRender(this.editor.render(Math.max(1, width - prefixWidth)))
    const frame = rendered.frame.map((line, index) => {
      if (index === 0 || (index === rendered.frame.length - 1 && isEditorBorder(line))) {
        return `${borderPrefix}${line}`
      }
      return `${index === 1 ? prefix : emptyPrefix}${line}`
    })

    return [
      ...rendered.autocomplete.map(line => `${emptyPrefix}${line}`),
      ...frame,
    ]
  }
}
