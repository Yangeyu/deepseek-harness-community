import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import {
  AUTOMATIC_SEARCH_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  TAVILY_PROVIDER_ID,
  type CommunityWebStatus,
} from '@vascent/deepseek-harness-web'
import { WebConfigView } from '../../src/presentation/config/web-view.ts'
import { createTheme } from '../../src/presentation/theme.ts'

const status: CommunityWebStatus = {
  search: {
    selection: AUTOMATIC_SEARCH_PROVIDER_ID,
    activeProviderId: TAVILY_PROVIDER_ID,
    providers: [{
      id: TAVILY_PROVIDER_ID,
      label: 'Tavily',
      description: 'Search through Tavily.',
      endpointHost: 'api.tavily.com',
      credentialRef: 'TAVILY_API_KEY',
      credentialConfigured: true,
      credentialSource: 'env',
      credentialWritable: true,
      available: true,
    }, {
      id: DEEPSEEK_PROVIDER_ID,
      label: 'DeepSeek Official',
      description: 'Use DeepSeek native web search.',
      endpointHost: 'api.deepseek.com',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialConfigured: true,
      credentialSource: 'env',
      credentialWritable: true,
      available: true,
    }],
  },
  extract: {
    activeProviderId: TAVILY_PROVIDER_ID,
    providers: [{
      id: TAVILY_PROVIDER_ID,
      label: 'Tavily',
      description: 'Extract readable Markdown through Tavily.',
      endpointHost: 'api.tavily.com',
      credentialRef: 'TAVILY_API_KEY',
      credentialConfigured: true,
      credentialSource: 'env',
      credentialWritable: true,
      available: true,
    }],
  },
}

describe('WebConfigView', () => {
  it('shows selectable search policy and secret-safe readiness for every provider', () => {
    const view = new WebConfigView(status, createTheme(false), vi.fn(), vi.fn(), vi.fn())
    const output = view.render(100).join('\n')

    expect(output).toContain('Automatic (current)')
    expect(output).toContain('Active now: Tavily')
    expect(output).toContain('DeepSeek Official')
    expect(output).toContain('TAVILY_API_KEY configured via env')
    expect(output).toContain('DEEPSEEK_API_KEY configured via env')
    expect(output).not.toContain('secret-value')
  })

  it('selects DeepSeek Official, refreshes, closes, and respects narrow widths', () => {
    const onProvider = vi.fn()
    const onRefresh = vi.fn()
    const onClose = vi.fn()
    const view = new WebConfigView(status, createTheme(false), onProvider, onRefresh, onClose)

    view.handleInput('G')
    view.handleInput('\r')
    view.handleInput('r')
    view.handleInput('\u001b')

    expect(onProvider).toHaveBeenCalledWith(DEEPSEEK_PROVIDER_ID)
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(view.render(32).every(line => visibleWidth(line) <= 32)).toBe(true)
  })

  it('renders newly registered providers without a view-specific option', () => {
    const onProvider = vi.fn()
    const extended: CommunityWebStatus = {
      ...status,
      search: {
        ...status.search,
        providers: [...status.search.providers, {
          id: 'future-provider',
          label: 'Future Provider',
          description: 'Registered at runtime.',
          available: true,
        }],
      },
    }
    const view = new WebConfigView(extended, createTheme(false), onProvider, vi.fn(), vi.fn())

    expect(view.render(100).join('\n')).toContain('Future Provider')
    view.handleInput('G')
    view.handleInput('\r')

    expect(onProvider).toHaveBeenCalledWith('future-provider')
  })

  it('makes a persisted selection recoverable when its provider is no longer registered', () => {
    const unavailableSelection: CommunityWebStatus = {
      ...status,
      search: {
        ...status.search,
        selection: 'removed-provider',
        activeProviderId: 'removed-provider',
      },
    }
    const onProvider = vi.fn()
    const view = new WebConfigView(unavailableSelection, createTheme(false), onProvider, vi.fn(), vi.fn())

    expect(view.render(100).join('\n')).toContain('Selected provider removed-provider is not registered')
    view.handleInput('\r')

    expect(onProvider).toHaveBeenCalledWith(AUTOMATIC_SEARCH_PROVIDER_ID)
  })
})
