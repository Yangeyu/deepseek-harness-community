import { truncateToWidth } from '@earendil-works/pi-tui'
import type { RewindPointSummary } from '../index.ts'
import { sanitizeTerminalText } from '../../../presentation/primitives/text.ts'
import type { TuiTheme } from '../../../presentation/primitives/theme.ts'
import type {
  SurfaceInputAction,
  SurfaceInputTarget,
} from '../../../presentation/primitives/surface-input.ts'

/** Bounded keyboard selector for retained user-turn Rewind points. */
export class RewindPointDialog implements SurfaceInputTarget {
  readonly inputContext = 'rewind-point' as const
  private readonly summaries: RewindPointSummary[]
  private index: number

  constructor(
    summaries: RewindPointSummary[],
    selectedPointId: string | undefined,
    private readonly visibleRows: () => number,
    private readonly theme: TuiTheme,
    private readonly onSelect: (summary: RewindPointSummary) => void,
    private readonly onCancel: () => void,
  ) {
    this.summaries = summaries
    const selected = selectedPointId === undefined
      ? summaries.length - 1
      : summaries.findIndex(summary => summary.pointId === selectedPointId)
    this.index = Math.max(0, selected)
  }

  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.previous') {
      this.move(-1)
      return
    }
    if (action === 'surface.next') {
      this.move(1)
      return
    }
    if (action === 'surface.page-previous') {
      this.move(-this.maxVisibleItems())
      return
    }
    if (action === 'surface.page-next') {
      this.move(this.maxVisibleItems())
      return
    }
    if (action === 'surface.confirm') {
      const selected = this.summaries[this.index]
      if (selected !== undefined) this.onSelect(selected)
      return
    }
    if (action === 'surface.back' || action === 'surface.cancel') this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const maxVisible = this.maxVisibleItems()
    const start = Math.max(0, Math.min(
      this.summaries.length - maxVisible,
      this.index - Math.floor(maxVisible / 2),
    ))
    const end = Math.min(this.summaries.length, start + maxVisible)
    const lines = [
      this.theme.bold('Rewind'),
      this.theme.dim('Choose a checkpoint, then restore code, conversation, or both…'),
      '',
    ]
    if (start > 0) lines.push(this.theme.dim(`  ↑ ${start} more above`), '')
    for (let row = start; row < end; row += 1) {
      const summary = this.summaries[row]
      if (summary === undefined) continue
      const selected = row === this.index
      const cursor = selected ? this.theme.accent('›') : ' '
      const prompt = sanitizeTerminalText(summary.prompt).replaceAll('\n', ' ')
      const fileStatus = summary.workspaceFiles === 0
        ? 'No AI file edits'
        : `${summary.workspaceFiles} AI-edited file${summary.workspaceFiles === 1 ? '' : 's'} this turn`
      const status = [
        summary.workspaceFiles === 0 ? this.theme.dim(fileStatus) : this.theme.secondary(fileStatus),
        summary.unsupportedFiles === 0
          ? ''
          : this.theme.warning(` · ${summary.unsupportedFiles} unsupported`),
        summary.imageCount === 0
          ? ''
          : this.theme.secondary(` · ${summary.imageCount} image${summary.imageCount === 1 ? '' : 's'}`),
        ...summary.participants.map(participant => this.theme.secondary(
          ` · ${participant.changes} ${participant.label.toLowerCase()} update${participant.changes === 1 ? '' : 's'}`,
        )),
      ].join('')
      lines.push(truncateToWidth(
        `${cursor} ${selected ? this.theme.bold(prompt) : prompt}`,
        width,
      ))
      lines.push(truncateToWidth(`    ${status}`, width), '')
    }
    if (end < this.summaries.length) lines.push(this.theme.dim(`  ↓ ${this.summaries.length - end} more below`), '')
    lines.push(this.theme.dim('↑/↓ select · Enter continue · Esc cancel'))
    return lines
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(this.summaries.length - 1, this.index + offset))
  }

  private maxVisibleItems(): number {
    return Math.max(1, Math.min(6, Math.floor((this.visibleRows() - 8) / 3)))
  }
}
