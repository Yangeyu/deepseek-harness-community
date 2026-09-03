import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import {
  AUTOMATIC_SEARCH_PROVIDER_ID,
  type CommunityWebCapabilityStatus,
  type CommunityWebProviderStatus,
  type CommunityWebStatus,
  type WebSearchSelection,
} from '@vascent/deepseek-harness-web'
import { sanitizeTerminalText } from '../../../presentation/primitives/text.ts'
import type { TuiTheme } from '../../../presentation/primitives/theme.ts'
import type {
  SurfaceInputAction,
  SurfaceInputTarget,
} from '../../../presentation/primitives/surface-input.ts'

interface SearchAction {
  value: WebSearchSelection
  label: string
  description: string
}

function activeProvider(capability: CommunityWebCapabilityStatus): CommunityWebProviderStatus | undefined {
  return capability.providers.find(provider => provider.id === capability.activeProviderId)
}

function credential(status: CommunityWebProviderStatus): string {
  if (status.credentialRef === undefined) return 'No credential required'
  if (status.credentialConfigured !== true) return `${status.credentialRef} missing`
  return `${status.credentialRef} configured${status.credentialSource === undefined ? '' : ` via ${status.credentialSource}`}`
}

function providerLine(status: CommunityWebProviderStatus, theme: TuiTheme): string {
  const state = status.available ? theme.success('✓') : theme.warning('!')
  const endpoint = status.endpointHost === undefined ? '' : ` · ${status.endpointHost}`
  return `  ${state} ${sanitizeTerminalText(status.label)}${sanitizeTerminalText(endpoint)}`
}

/** Persistent search-provider policy with secret-safe readiness for every Web capability. */
export class WebConfigView implements SurfaceInputTarget {
  readonly inputContext = 'web-menu' as const
  private index: number

  constructor(
    private status: CommunityWebStatus,
    private readonly theme: TuiTheme,
    private readonly onSearchProvider: (provider: WebSearchSelection) => void,
    private readonly onRefresh: () => void,
    private readonly onClose: () => void,
  ) {
    this.index = Math.max(0, this.actions().findIndex(action => action.value === status.search.selection))
  }

  setStatus(status: CommunityWebStatus): void {
    this.status = status
    this.index = Math.min(this.index, Math.max(0, this.actions().length - 1))
  }

  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.back' || action === 'surface.cancel') return this.onClose()
    if (action === 'surface.previous') return this.move(-1)
    if (action === 'surface.next') return this.move(1)
    if (action === 'surface.first') this.index = 0
    else if (action === 'surface.last') this.index = this.actions().length - 1
    else if (action === 'surface.refresh') this.onRefresh()
    else if (action === 'surface.confirm' || action === 'surface.toggle') this.select()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const activeSearch = activeProvider(this.status.search)
    const activeExtract = activeProvider(this.status.extract)
    const lines = [
      this.theme.bold('Web'),
      this.theme.dim(`Search · ${sanitizeTerminalText(activeSearch?.label ?? this.status.search.activeProviderId)} · Page reading · ${sanitizeTerminalText(activeExtract?.label ?? this.status.extract.activeProviderId)}`),
      '',
      this.theme.bold('Search provider'),
    ]
    if (activeSearch === undefined) {
      lines.push(this.theme.warning(
        `Selected provider ${sanitizeTerminalText(this.status.search.activeProviderId)} is not registered. Choose Automatic or another provider.`,
      ))
    }
    for (const [index, action] of this.actions().entries()) {
      const selected = index === this.index
      const current = action.value === this.status.search.selection
      const cursor = selected ? this.theme.accent('›') : ' '
      const label = selected ? this.theme.bold(action.label) : action.label
      lines.push(`${cursor} ${label}${current ? this.theme.dim(' (current)') : ''}`)
      if (selected) {
        lines.push(...wrapTextWithAnsi(
          this.theme.dim(action.description),
          Math.max(1, safeWidth - 4),
        ).map(line => `    ${line}`))
        if (action.value === AUTOMATIC_SEARCH_PROVIDER_ID) {
          lines.push(`    ${this.theme.dim(`Active now: ${activeSearch?.label ?? this.status.search.activeProviderId}`)}`)
        }
      }
    }
    lines.push('', this.theme.bold('Provider readiness'))
    for (const provider of this.status.search.providers) {
      lines.push(providerLine(provider, this.theme))
      lines.push(`    ${this.theme.dim(sanitizeTerminalText(credential(provider)))}`)
    }
    lines.push('', this.theme.bold('Page reading'))
    if (activeExtract === undefined) {
      lines.push(`  ${this.theme.warning('!')} ${sanitizeTerminalText(this.status.extract.activeProviderId)} is not registered`)
    } else {
      lines.push(providerLine(activeExtract, this.theme))
      lines.push(`    ${this.theme.dim(sanitizeTerminalText(credential(activeExtract)))}`)
    }
    lines.push('', this.theme.dim('j/k move · enter apply · r refresh · g/G first/last · esc close'))
    return lines.map(line => truncateToWidth(line, safeWidth))
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(this.actions().length - 1, this.index + offset))
  }

  private select(): void {
    const provider = this.actions()[this.index]?.value
    if (provider !== undefined && provider !== this.status.search.selection) this.onSearchProvider(provider)
  }

  private actions(): readonly SearchAction[] {
    return [{
      value: AUTOMATIC_SEARCH_PROVIDER_ID,
      label: 'Automatic',
      description: 'Use the highest-priority ready provider and reevaluate local readiness before every search.',
    }, ...this.status.search.providers.map(provider => ({
      value: provider.id,
      label: provider.label,
      description: provider.description,
    }))]
  }
}
