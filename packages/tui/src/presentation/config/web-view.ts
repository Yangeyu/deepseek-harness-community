import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type {
  CommunityWebProviderStatus,
  CommunityWebStatus,
} from '@vascent/deepseek-harness-web'
import { sanitizeTerminalText } from '../../text.ts'
import type { TuiTheme } from '../theme.ts'

function credential(status: CommunityWebProviderStatus): string {
  if (!status.credentialConfigured) return `${status.credentialRef} missing`
  return `${status.credentialRef} configured${status.credentialSource === undefined ? '' : ` via ${status.credentialSource}`}`
}

function capabilityLines(label: string, status: CommunityWebProviderStatus, theme: TuiTheme): string[] {
  const endpoint = status.endpointHost === undefined ? '' : ` · ${status.endpointHost}`
  return [
    theme.bold(label),
    `  ${sanitizeTerminalText(status.id)}${sanitizeTerminalText(endpoint)}`,
  ]
}

function credentialStatuses(status: CommunityWebStatus): CommunityWebProviderStatus[] {
  const unique = new Map<string, CommunityWebProviderStatus>()
  for (const provider of [status.search, status.extract]) unique.set(provider.credentialRef, provider)
  return [...unique.values()]
}

/** Read-only, secret-safe status for the selected Web providers. */
export class WebConfigView implements Component {
  constructor(
    private status: CommunityWebStatus,
    private readonly theme: TuiTheme,
    private readonly onRefresh: () => void,
    private readonly onClose: () => void,
  ) {}

  setStatus(status: CommunityWebStatus): void {
    this.status = status
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.onClose()
      return
    }
    if (data === 'r' || data === 'R' || matchesKey(data, Key.enter)) this.onRefresh()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const credentials = credentialStatuses(this.status)
    const missing = credentials
      .filter(status => !status.credentialConfigured)
      .map(status => status.credentialRef)
    const lines = [
      this.theme.bold('Web'),
      this.theme.dim('Tavily-backed web_search and web_extract'),
      '',
      this.theme.bold('Credential'),
      ...credentials.map(status => (
        `  ${status.credentialConfigured ? this.theme.success('✓') : this.theme.warning('!')} ${sanitizeTerminalText(credential(status))}`
      )),
      '',
      ...capabilityLines('Search', this.status.search, this.theme),
      '',
      ...capabilityLines('Page reading', this.status.extract, this.theme),
    ]
    if (missing.length > 0) {
      lines.push(
        '',
        ...wrapTextWithAnsi(
          this.theme.warning(sanitizeTerminalText(`Configure ${missing.join(' and ')} through Harness credentials or the launch environment.`)),
          Math.max(1, width),
        ),
      )
    }
    lines.push('', this.theme.dim('r/enter refresh · esc close'))
    const safeWidth = Math.max(1, width)
    return lines.map(line => truncateToWidth(line, safeWidth))
  }
}
