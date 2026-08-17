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

interface VisionAction {
  mode: VisionMode
  label: string
  description: string
}

const ACTIONS: readonly VisionAction[] = [{
  mode: 'auto',
  label: 'Auto',
  description: 'Use the active model when it supports images; otherwise use the configured Vision proxy.',
}, {
  mode: 'proxy',
  label: 'Always use proxy',
  description: 'Analyze every attached image with the configured Vision proxy before the main model runs.',
}, {
  mode: 'disabled',
  label: 'Disabled',
  description: 'Reject image submissions while leaving ordinary text prompts unchanged.',
}]

/** Keyboard-first Vision settings surface backed by the host settings service. */
export class VisionConfigView implements Component {
  private index = 0

  constructor(
    private status: VisionStatus,
    private readonly theme: TuiTheme,
    private readonly onMode: (mode: VisionMode) => void,
    private readonly onClose: () => void,
  ) {}

  setStatus(status: VisionStatus): void {
    this.status = status
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.onClose()
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
    const route = `${this.status.config.proxyProvider}/${this.status.config.proxyModel}`
    const routeState = this.status.proxyRegistered
      ? this.status.proxySupportsImages ? 'multimodal' : 'image capability missing'
      : 'not registered'
    const lines = [
      this.theme.bold('Vision'),
      this.theme.dim(`TUI · Proxy ${sanitizeTerminalText(route)} · ${routeState}`),
      this.theme.dim(`Bounds · ${String(this.status.config.maxTokens)} tokens · ${String(this.status.config.maxObservationChars)} observation chars`),
      '',
    ]
    for (const [index, action] of ACTIONS.entries()) {
      const selected = index === this.index
      const cursor = selected ? this.theme.accent('›') : ' '
      const current = action.mode === this.status.config.mode
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
    if (action.mode !== this.status.config.mode) this.onMode(action.mode)
  }
}
