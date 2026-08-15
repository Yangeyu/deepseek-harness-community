import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type { PresetOption } from '@deepseek-ai/dsh-permission-presets/client'
import { sanitizeTerminalText } from '../../text.ts'
import {
  configurationRows,
  reasoningEfforts,
  type ConfigurationSnapshot,
} from '../../runtime/session-controls.ts'
import type { TuiTheme } from '../theme.ts'

interface ActionRow<T extends string> {
  value: T
  label: string
  description?: string
  dangerous?: boolean
}

export type ConfigEntryStage = 'root' | 'reasoning' | 'permissions' | 'plan'
type Stage = ConfigEntryStage | 'permission-confirm'

/** Unified keyboard-first configuration surface over authoritative session state. */
export class ConfigView implements Component {
  private stage: Stage
  private readonly entryStage: ConfigEntryStage
  private index = 0
  private pendingPermission: PresetOption | undefined

  constructor(
    private snapshot: ConfigurationSnapshot,
    private readonly theme: TuiTheme,
    private readonly onModel: () => void,
    private readonly onReasoning: (effort: string | undefined) => void,
    private readonly onPermission: (value: string) => void,
    private readonly onPlan: (active: boolean) => void,
    private readonly onDetails: (expanded: boolean) => void,
    private readonly onClose: () => void,
    initialStage: ConfigEntryStage = 'root',
  ) {
    this.stage = initialStage
    this.entryStage = initialStage
  }

  setSnapshot(snapshot: ConfigurationSnapshot): void {
    this.snapshot = snapshot
    this.index = Math.min(this.index, Math.max(0, this.rowCount() - 1))
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.stage === this.entryStage) this.onClose()
      else if (this.stage === 'permission-confirm') {
        this.stage = 'permissions'
        this.pendingPermission = undefined
      } else {
        this.stage = 'root'
        this.index = 0
      }
      return
    }
    if (matchesKey(data, Key.up) || data === 'k') {
      this.move(-1)
      return
    }
    if (matchesKey(data, Key.down) || data === 'j') {
      this.move(1)
      return
    }
    if (data === 'g') {
      this.index = 0
      return
    }
    if (data === 'G') {
      this.index = Math.max(0, this.rowCount() - 1)
      return
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.select()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = this.stage === 'permission-confirm'
      ? this.renderPermissionConfirmation(width)
      : this.stage === 'root'
        ? this.renderRoot(width)
        : this.renderActions(width)
    const safeWidth = Math.max(1, width)
    return lines.map(line => truncateToWidth(line, safeWidth))
  }

  private renderRoot(width: number): string[] {
    const lines = [
      this.theme.bold('Config'),
      this.theme.dim('Session settings and terminal preferences'),
      '',
    ]
    for (const [index, row] of configurationRows(this.snapshot).entries()) {
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const label = index === this.index ? this.theme.bold(row.label.padEnd(13)) : row.label.padEnd(13)
      const value = row.available ? sanitizeTerminalText(row.value) : this.theme.dim(sanitizeTerminalText(row.value))
      const scope = this.theme.dim(`  ${row.scope}`)
      lines.push(truncateToWidth(`${cursor} ${label}${value}${scope}`, width))
    }
    lines.push('', this.theme.dim('j/k move · enter configure · g/G first/last · esc close'))
    return lines
  }

  private renderActions(width: number): string[] {
    const title = this.stage === 'reasoning' ? 'Reasoning Effort'
      : this.stage === 'permissions' ? 'Permission'
        : 'Plan Mode'
    const actions = this.actions()
    const lines = [this.theme.bold(title), this.theme.dim(this.stageDetail()), '']
    if (actions.length === 0) lines.push(this.theme.dim('No options are currently available.'))
    for (const [index, action] of actions.entries()) {
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const current = this.isCurrentAction(action.value)
      const marker = current ? this.theme.dim(' (current)') : ''
      const label = index === this.index ? this.theme.bold(action.label) : action.label
      lines.push(truncateToWidth(`${cursor} ${label}${marker}`, width))
      if (action.description !== undefined && index === this.index) {
        lines.push(...wrapTextWithAnsi(
          this.theme.dim(sanitizeTerminalText(action.description)),
          Math.max(1, width - 4),
        ).map(line => `    ${line}`))
      }
    }
    lines.push('', this.theme.dim('j/k move · enter apply · esc back'))
    return lines
  }

  private renderPermissionConfirmation(width: number): string[] {
    const option = this.pendingPermission
    const description = option?.description ?? 'This preset grants unrestricted filesystem and process access.'
    return [
      this.theme.bold(this.theme.warning('Confirm unrestricted access')),
      '',
      ...wrapTextWithAnsi(sanitizeTerminalText(description), Math.max(1, width)),
      '',
      this.theme.warning(`Switch to ${sanitizeTerminalText(option?.name ?? 'danger-full-access')}?`),
      this.theme.dim('enter confirm · esc cancel'),
    ]
  }

  private select(): void {
    if (this.stage === 'permission-confirm') {
      const value = this.pendingPermission?.value
      this.pendingPermission = undefined
      this.stage = this.entryStage
      this.index = 0
      if (value !== undefined) this.onPermission(value)
      return
    }
    if (this.stage === 'root') {
      const row = configurationRows(this.snapshot)[this.index]
      if (row === undefined || !row.available) return
      if (row.kind === 'model') {
        this.onModel()
        return
      }
      if (row.kind === 'details') {
        this.onDetails(!this.snapshot.detailsExpanded)
        return
      }
      this.stage = row.kind
      this.index = 0
      return
    }
    const action = this.actions()[this.index]
    if (action === undefined) return
    if (this.stage === 'reasoning') {
      if (this.isCurrentAction(action.value)) return
      this.onReasoning(action.value === 'provider-default' ? undefined : action.value)
      return
    }
    if (this.stage === 'permissions') {
      const option = this.permissionOptions().find(candidate => candidate.value === action.value)
      if (option === undefined || this.isCurrentAction(option.value)) return
      if (action.dangerous) {
        this.pendingPermission = option
        this.stage = 'permission-confirm'
        return
      }
      this.onPermission(option.value)
      return
    }
    if (this.snapshot.plan?.pending || this.isCurrentAction(action.value)) return
    this.onPlan(action.value === 'on')
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(Math.max(0, this.rowCount() - 1), this.index + offset))
  }

  private rowCount(): number {
    if (this.stage === 'root') return configurationRows(this.snapshot).length
    if (this.stage === 'permission-confirm') return 1
    return this.actions().length
  }

  private permissionOptions(): PresetOption[] {
    return (this.snapshot.permissions?.options ?? []).filter(option => option.value !== 'custom')
  }

  private actions(): readonly ActionRow<string>[] {
    if (this.stage === 'reasoning') {
      return [{
        value: 'provider-default',
        label: 'Provider default',
        description: 'Let the selected model adapter choose its default reasoning effort.',
      }, ...reasoningEfforts(this.snapshot).map(effort => ({
        value: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      }))]
    }
    if (this.stage === 'permissions') {
      return this.permissionOptions().map(option => ({
        value: option.value,
        label: option.name,
        ...option.description === undefined ? {} : { description: option.description },
        dangerous: option.value === 'danger-full-access',
      }))
    }
    if (this.stage === 'plan') {
      return [
        { value: 'on', label: 'On', description: 'Plan before implementation.' },
        { value: 'off', label: 'Off', description: 'Return to normal implementation mode.' },
      ]
    }
    return []
  }

  private stageDetail(): string {
    if (this.stage === 'reasoning') {
      return `Session · Effective: ${this.snapshot.models?.current.reasoningEffort ?? 'provider default'}`
    }
    if (this.stage === 'permissions') {
      return `Session · Effective: ${this.snapshot.permissions?.currentValue ?? 'unavailable'}`
    }
    const plan = this.snapshot.plan
    return plan === undefined
      ? 'Session · Unavailable'
      : `Session · Effective: ${plan.active ? 'active' : 'off'}${plan.pending ? ' · transition pending' : ''}`
  }

  private isCurrentAction(value: string): boolean {
    if (this.stage === 'reasoning') {
      return value === (this.snapshot.models?.current.reasoningEffort ?? 'provider-default')
    }
    if (this.stage === 'permissions') return value === this.snapshot.permissions?.currentValue
    if (this.stage === 'plan') return (value === 'on') === this.snapshot.plan?.active
    return false
  }
}
