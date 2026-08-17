import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type { RewindPlan } from '../../rewind/index.ts'
import { sanitizeTerminalText } from '../../text.ts'
import type { TuiTheme } from '../theme.ts'

function relativeAge(time: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Confirmation for coordinated workspace, participant, and conversation rewind. */
export class RewindDialog implements Component {
  private selected: number
  private bodyOffset = 0
  private bodyPageRows = 1
  private bodyMaxOffset = 0

  constructor(
    private readonly plan: RewindPlan,
    private readonly visibleRows: () => number,
    private readonly theme: TuiTheme,
    private readonly onConfirm: () => void,
    private readonly onCancel: () => void,
  ) {
    this.selected = plan.state === 'conflict' || plan.state === 'unsupported' ? 1 : 0
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selected = 0
      return
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.selected = 1
      return
    }
    if (matchesKey(data, Key.pageUp)) {
      this.bodyOffset = Math.max(0, this.bodyOffset - this.bodyPageRows)
      return
    }
    if (matchesKey(data, Key.pageDown)) {
      this.bodyOffset = Math.min(this.bodyMaxOffset, this.bodyOffset + this.bodyPageRows)
      return
    }
    if (data === '1' || data === '2') {
      this.selected = Number(data) - 1
      return
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selected === 0) {
        if (this.plan.state !== 'conflict' && this.plan.state !== 'unsupported') this.onConfirm()
        return
      }
      this.onCancel()
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const prompt = sanitizeTerminalText(this.plan.input.text).replaceAll('\n', ' ')
    const changed = this.plan.files.length
    const confirmation = wrapTextWithAnsi(
      this.theme.dim('Confirm you want to restore the workspace, memory, and conversation to the point before you sent this message:'),
      width,
    )
    const promptLines = wrapTextWithAnsi(prompt, Math.max(1, width - 2))
    const impact = wrapTextWithAnsi(this.theme.dim(changed === 0
      ? 'The code will be unchanged.'
      : `${changed} source-attributed file${changed === 1 ? '' : 's'} ${changed === 1 ? 'is' : 'are'} included in this plan.`), width)
    const participantImpact = this.plan.participants.flatMap(participant => wrapTextWithAnsi(
      this.theme.dim(`${participant.changes} ${participant.label.toLowerCase()} update${participant.changes === 1 ? '' : 's'} will be reverted.`),
      width,
    ))
    const imageImpact = this.plan.input.attachments.length === 0
      ? []
      : [this.theme.dim(`${String(this.plan.input.attachments.length)} attached image${this.plan.input.attachments.length === 1 ? '' : 's'} will be restored to the Composer.`)]
    const body = [
      this.theme.bold('Rewind'),
      '',
      ...confirmation,
      '',
      ...promptLines.map(line => `${this.theme.dim('│')} ${this.theme.bold(line)}`),
      `${this.theme.dim('│')} ${this.theme.dim(`(${relativeAge(this.plan.createdAt)})`)}`,
      '',
      this.theme.dim('The conversation will be forked.'),
      ...impact,
      ...imageImpact,
      ...participantImpact,
      '',
    ]
    const blocked = this.plan.state === 'conflict' || this.plan.state === 'unsupported'
    if (this.plan.state === 'mergeable') {
      body.push(this.theme.dim('Non-overlapping later edits will be preserved.'), '')
    } else if (blocked) {
      body.push(this.theme.warning('Restore is disabled until the Rewind conflict is resolved.'), '')
    }
    for (const participant of this.plan.participants) {
      if (participant.state === 'conflict' || participant.state === 'unsupported') {
        body.push(...wrapTextWithAnsi(this.theme.warning(`○ ${participant.label} — ${participant.reason}`), width))
      }
    }
    for (const file of this.plan.files) {
      const marker = file.state === 'safe' ? '●' : file.state === 'mergeable' ? '◐' : '○'
      const reason = file.state === 'conflict' || file.state === 'unsupported' ? ` — ${file.reason}` : ''
      body.push(...wrapTextWithAnsi(
        blocked ? this.theme.warning(`${marker} ${file.path}${reason}`) : this.theme.dim(`${marker} ${file.path}${reason}`),
        width,
      ))
    }
    if (this.plan.files.length > 0) body.push('')
    const restore = `${this.selected === 0 ? '›' : ' '} 1. Restore workspace, memory, and conversation${blocked ? ' (unavailable)' : ''}`
    const cancel = `${this.selected === 1 ? '›' : ' '} 2. Never mind`
    const actions = [
      this.selected === 0 ? this.theme.accent(restore) : restore,
      this.selected === 1 ? this.theme.accent(cancel) : cancel,
      '',
      this.theme.dim('↑/↓ select · PgUp/PgDn details · Enter confirm · Esc back'),
    ]
    const available = Math.max(3, this.visibleRows() - actions.length)
    this.bodyMaxOffset = Math.max(0, body.length - Math.max(1, available - 1))
    this.bodyOffset = Math.min(this.bodyOffset, this.bodyMaxOffset)
    const hasAbove = this.bodyOffset > 0
    let capacity = available - (hasAbove ? 1 : 0)
    let end = Math.min(body.length, this.bodyOffset + capacity)
    if (end < body.length) {
      capacity = Math.max(1, capacity - 1)
      end = Math.min(body.length, this.bodyOffset + capacity)
    }
    this.bodyPageRows = Math.max(1, capacity)
    const window = [
      ...hasAbove ? [this.theme.dim(`↑ ${String(this.bodyOffset)} more`)] : [],
      ...body.slice(this.bodyOffset, end),
      ...end < body.length ? [this.theme.dim(`↓ ${String(body.length - end)} more`)] : [],
    ]
    return [...window, ...actions].map(line => truncateToWidth(line, width))
  }
}
