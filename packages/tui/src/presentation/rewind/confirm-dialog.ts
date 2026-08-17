import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type { RewindAction, RewindPlan } from '../../rewind/index.ts'
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
    private readonly onConfirm: (action: RewindAction) => void,
    private readonly onCancel: () => void,
  ) {
    this.selected = this.codeRestoreAvailable() ? 0 : 1
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1)
      return
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.moveSelection(1)
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
    if (data === '1' || data === '2' || data === '3' || data === '4') {
      this.selected = Number(data) - 1
      return
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.actions()[this.selected]
      if (selected?.available !== true) return
      if (selected.action === undefined) this.onCancel()
      else this.onConfirm(selected.action)
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const prompt = sanitizeTerminalText(this.plan.input.text).replaceAll('\n', ' ')
    const changed = this.plan.files.length
    const confirmation = wrapTextWithAnsi(
      this.theme.dim('Choose what to restore to the checkpoint before you sent this message:'),
      width,
    )
    const promptLines = wrapTextWithAnsi(prompt, Math.max(1, width - 2))
    const impact = wrapTextWithAnsi(this.theme.dim(changed === 0
      ? 'No source-attributed files are included in this checkpoint.'
      : `${changed} source-attributed file${changed === 1 ? '' : 's'} ${changed === 1 ? 'is' : 'are'} included in this plan.`), width)
    const participantImpact = this.plan.participants.flatMap(participant => wrapTextWithAnsi(
      this.theme.dim(`${participant.changes} ${participant.label.toLowerCase()} update${participant.changes === 1 ? '' : 's'} will be reverted when code state is restored.`),
      width,
    ))
    const imageImpact = this.plan.input.attachments.length === 0
      ? []
      : [this.theme.dim(`${String(this.plan.input.attachments.length)} attached image${this.plan.input.attachments.length === 1 ? '' : 's'} will return to the Composer when conversation state is restored.`)]
    const body = [
      this.theme.bold('Rewind'),
      '',
      ...confirmation,
      '',
      ...promptLines.map(line => `${this.theme.dim('│')} ${this.theme.bold(line)}`),
      `${this.theme.dim('│')} ${this.theme.dim(`(${relativeAge(this.plan.createdAt)})`)}`,
      '',
      this.theme.dim('Restoring conversation state creates a fork; restoring code alone keeps this conversation.'),
      ...impact,
      ...imageImpact,
      ...participantImpact,
      '',
    ]
    const blocked = this.plan.state === 'conflict' || this.plan.state === 'unsupported'
    if (this.plan.state === 'mergeable') {
      body.push(this.theme.dim('Non-overlapping later edits will be preserved.'), '')
    } else if (blocked) {
      body.push(this.theme.warning('Code restore is unavailable for this checkpoint; conversation-only restore is still available.'), '')
    }
    if (this.plan.codeScope === 'forward-unavailable' || this.plan.codeScope === 'none') {
      body.push(...wrapTextWithAnsi(this.theme.warning(this.plan.codeReason
        ?? 'No reversible code state is retained for this checkpoint.'), width), '')
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
    const rows = this.actions()
    const actions = [
      ...rows.map((row, index) => {
        const marker = this.selected === index ? '›' : ' '
        const line = `${marker} ${String(index + 1)}. ${row.label}${row.available ? '' : ' (unavailable)'}`
        if (!row.available) return this.theme.dim(line)
        return this.selected === index ? this.theme.accent(line) : line
      }),
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

  private codeRestoreAvailable(): boolean {
    return this.plan.codeScope === 'backward'
      && this.plan.state !== 'conflict'
      && this.plan.state !== 'unsupported'
  }

  private actions(): ReadonlyArray<{
    readonly action?: RewindAction
    readonly label: string
    readonly available: boolean
  }> {
    const code = this.codeRestoreAvailable()
    return [
      { action: 'code-and-conversation', label: 'Restore code and conversation', available: code },
      { action: 'conversation-only', label: 'Restore conversation only', available: true },
      { action: 'code-only', label: 'Restore code only', available: code },
      { label: 'Never mind', available: true },
    ]
  }

  private moveSelection(direction: -1 | 1): void {
    const rows = this.actions()
    let selected = this.selected
    for (let index = 0; index < rows.length; index += 1) {
      selected = (selected + direction + rows.length) % rows.length
      if (rows[selected]?.available === true) {
        this.selected = selected
        return
      }
    }
  }
}
