import {
  truncateToWidth,
  wrapTextWithAnsi,
  type SelectItem,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../../presentation/primitives/text.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import type {
  SurfaceInputAction,
  SurfaceInputTarget,
} from '../../presentation/primitives/surface-input.ts'

export type ApprovalDecision = 'allowed-once' | 'rejected'

/** Compact high-salience decision surface for one blocking tool approval. */
export class ApprovalDialog implements SurfaceInputTarget {
  readonly inputContext = 'approval' as const
  private selected = 0

  constructor(
    private readonly toolName: string,
    private readonly reason: string | undefined,
    private readonly theme: TuiTheme,
    private readonly onSelect: (decision: ApprovalDecision) => void,
    private readonly onCancel: () => void,
  ) {}

  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.previous') {
      this.selected = this.selected === 0 ? 1 : 0
      return
    }
    if (action === 'surface.next') {
      this.selected = this.selected === 1 ? 0 : 1
      return
    }
    if (action === 'surface.select-1' || action === 'surface.select-2') {
      this.selected = action === 'surface.select-1' ? 0 : 1
      return
    }
    if (action === 'surface.confirm') {
      this.onSelect(this.selected === 0 ? 'allowed-once' : 'rejected')
      return
    }
    if (action === 'surface.back' || action === 'surface.cancel') this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const toolName = sanitizeTerminalText(this.toolName).replaceAll('\n', ' ')
    const lines = [
      this.theme.bold(this.theme.warning(`Permission required · ${toolName}`)),
      ...(this.reason === undefined
        ? []
        : wrapTextWithAnsi(this.theme.secondary(sanitizeTerminalText(this.reason)), safeWidth)),
      '',
      this.actionRow(0, 'Allow once'),
      this.actionRow(1, 'Reject and continue'),
      ...this.indentedSecondary(
        'Reject declines only this tool call; the task keeps running.',
        safeWidth,
      ),
      '',
      ...wrapTextWithAnsi(
        this.theme.secondary('↑/↓ select · Enter confirm · Esc/Ctrl+C interrupt task'),
        safeWidth,
      ),
    ]
    return lines.map(line => truncateToWidth(line, safeWidth, ''))
  }

  private actionRow(index: number, label: string): string {
    const selected = this.selected === index
    const cursor = selected ? this.theme.accent('›') : ' '
    const text = selected ? this.theme.bold(label) : label
    return `${cursor} ${String(index + 1)}. ${text}`
  }

  private indentedSecondary(text: string, width: number): string[] {
    const indent = '     '
    return wrapTextWithAnsi(
      this.theme.secondary(text),
      Math.max(1, width - indent.length),
    ).map(line => `${indent}${line}`)
  }
}

function visibleRange(total: number, selected: number, pageRows: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(total, pageRows))
  const start = Math.max(0, Math.min(total - size, selected - size + 1))
  return { start, end: Math.min(total, start + size) }
}

/** Multi-select question dialog: Space toggles and Enter submits. */
export class MultiSelectDialog implements SurfaceInputTarget {
  readonly inputContext = 'multi-select' as const
  private index = 0
  private readonly selected = new Set<string>()

  constructor(
    private readonly title: string,
    private readonly items: SelectItem[],
    private readonly visibleRows: () => number,
    private readonly theme: TuiTheme,
    private readonly onSubmit: (selected: string[]) => void,
    private readonly onCustom: (selected: string[]) => void,
    private readonly onCancel: () => void,
  ) {}

  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.previous') {
      this.index = Math.max(0, this.index - 1)
      return
    }
    if (action === 'surface.next') {
      this.index = Math.min(this.items.length, this.index + 1)
      return
    }
    if (action === 'surface.page-previous') {
      this.index = Math.max(0, this.index - this.pageItems())
      return
    }
    if (action === 'surface.page-next') {
      this.index = Math.min(this.items.length, this.index + this.pageItems())
      return
    }
    if (action === 'surface.toggle') {
      const item = this.items[this.index]
      if (item === undefined) {
        this.onCustom([...this.selected])
        return
      }
      if (this.selected.has(item.value)) this.selected.delete(item.value)
      else this.selected.add(item.value)
      return
    }
    if (action === 'surface.confirm') {
      if (this.index === this.items.length) {
        this.onCustom([...this.selected])
        return
      }
      if (this.selected.size === 0) {
        const item = this.items[this.index]
        if (item !== undefined) this.selected.add(item.value)
      }
      if (this.selected.size > 0) this.onSubmit([...this.selected])
      return
    }
    if (action === 'surface.back' || action === 'surface.cancel') this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = [this.theme.bold(sanitizeTerminalText(this.title)), this.theme.dim('Space toggle · Enter confirm')]
    const total = this.items.length + 1
    const range = visibleRange(total, this.index, this.pageItems())
    for (let index = range.start; index < Math.min(range.end, this.items.length); index += 1) {
      const item = this.items[index]!
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const checked = this.selected.has(item.value) ? this.theme.success('[x]') : '[ ]'
      lines.push(truncateToWidth(`${cursor} ${checked} ${sanitizeTerminalText(item.label)}`, width))
      if (item.description !== undefined) {
        lines.push(truncateToWidth(`      ${this.theme.dim(sanitizeTerminalText(item.description))}`, width))
      }
    }
    if (range.end > this.items.length) {
      const customCursor = this.index === this.items.length ? this.theme.accent('›') : ' '
      lines.push(truncateToWidth(`${customCursor} [ ] Other…`, width))
    }
    if (total > range.end - range.start) {
      lines.push(this.theme.dim(`${String(range.start + 1)}-${String(range.end)}/${String(total)}`))
    }
    return lines
  }

  private pageItems(): number {
    return Math.max(1, Math.floor((this.visibleRows() - 3) / 2))
  }
}
