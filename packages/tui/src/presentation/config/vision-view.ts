import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type {
  VisionMode,
  VisionStatus,
} from '@vascent/deepseek-harness-vision'
import type { TuiTheme } from '../theme.ts'
import { sanitizeTerminalText } from '../../text.ts'

type VisionAction =
  | { kind: 'mode'; mode: VisionMode; label: string; description: string }
  | { kind: 'configure'; label: string; description: string }

const ACTIONS: readonly VisionAction[] = [{
  kind: 'mode',
  mode: 'auto',
  label: 'Auto',
  description: 'Use the active model when it supports images; otherwise use the configured Vision proxy.',
}, {
  kind: 'mode',
  mode: 'proxy',
  label: 'Always use proxy',
  description: 'Analyze every attached image with the configured Vision proxy before the main model runs.',
}, {
  kind: 'mode',
  mode: 'disabled',
  label: 'Disabled',
  description: 'Reject image submissions while leaving ordinary text prompts unchanged.',
}, {
  kind: 'configure',
  label: 'Configure DashScope recommendation',
  description: 'Register dashscope-vision/qwen3.7-plus with DASHSCOPE_API_KEY. The secret value is never copied into settings.',
}]

/** Keyboard-first Vision settings surface backed by the host settings service. */
export class VisionConfigView implements Component {
  private index = 0
  private confirmingConfigure = false

  constructor(
    private status: VisionStatus,
    private readonly theme: TuiTheme,
    private readonly onMode: (mode: VisionMode) => void,
    private readonly onConfigure: () => void,
    private readonly onClose: () => void,
  ) {}

  setStatus(status: VisionStatus): void {
    this.status = status
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.confirmingConfigure) this.confirmingConfigure = false
      else this.onClose()
      return
    }
    if (this.confirmingConfigure) {
      if (matchesKey(data, Key.enter)) {
        this.confirmingConfigure = false
        this.onConfigure()
      }
      return
    }
    if (matchesKey(data, Key.up) || data === 'k') return this.move(-1)
    if (matchesKey(data, Key.down) || data === 'j') return this.move(1)
    if (data === 'g') this.index = 0
    else if (data === 'G') this.index = ACTIONS.length - 1
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.select()
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.confirmingConfigure) {
      return [
        this.theme.bold('Configure recommended DashScope route?'),
        '',
        ...wrapTextWithAnsi(
          'This writes the dashscope-vision/qwen3.7-plus provider profile and references DASHSCOPE_API_KEY. It does not read, copy, or display the secret value.',
          Math.max(1, width),
        ),
        '',
        this.theme.dim('enter confirm · esc cancel'),
      ].map(line => truncateToWidth(line, Math.max(1, width)))
    }
    const credential = this.status.credentialRef === undefined
      ? 'credential route not registered'
      : this.status.credentialConfigured === true
        ? `${this.status.credentialRef} configured${this.status.credentialSource === undefined ? '' : ` via ${this.status.credentialSource}`}`
        : `${this.status.credentialRef} missing`
    const route = `${this.status.config.proxyProvider}/${this.status.config.proxyModel}`
    const routeState = this.status.proxyRegistered
      ? this.status.proxySupportsImages ? 'multimodal' : 'image capability missing'
      : 'not registered'
    const lines = [
      this.theme.bold('Vision'),
      this.theme.dim(`TUI · Proxy ${sanitizeTerminalText(route)} · ${routeState}`),
      ...this.status.proxyEndpointHost === undefined ? [] : [this.theme.dim(`Endpoint · ${sanitizeTerminalText(this.status.proxyEndpointHost)}`)],
      this.theme.dim(sanitizeTerminalText(credential)),
      this.theme.dim(`Bounds · ${String(this.status.config.maxTokens)} tokens · ${String(this.status.config.maxObservationChars)} observation chars`),
      '',
    ]
    for (const [index, action] of ACTIONS.entries()) {
      const selected = index === this.index
      const cursor = selected ? this.theme.accent('›') : ' '
      const current = action.kind === 'mode' && action.mode === this.status.config.mode
      const label = selected ? this.theme.bold(action.label) : action.label
      lines.push(`${cursor} ${label}${current ? this.theme.dim(' (current)') : ''}`)
      if (selected) {
        lines.push(...wrapTextWithAnsi(
          this.theme.dim(action.description),
          Math.max(1, width - 4),
        ).map(line => `    ${line}`))
      }
    }
    lines.push('', this.theme.dim('j/k move · enter apply · g/G first/last · esc close'))
    return lines.map(line => truncateToWidth(line, Math.max(1, width)))
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(ACTIONS.length - 1, this.index + offset))
  }

  private select(): void {
    const action = ACTIONS[this.index]
    if (action === undefined) return
    if (action.kind === 'configure') this.confirmingConfigure = true
    else if (action.mode !== this.status.config.mode) this.onMode(action.mode)
  }
}
