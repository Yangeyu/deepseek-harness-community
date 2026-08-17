import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { WebConfigView } from '../../src/presentation/config/web-view.ts'
import { createTheme } from '../../src/presentation/theme.ts'

const status = {
  search: {
    id: 'community-tavily',
    endpointHost: 'api.tavily.com',
    credentialRef: 'TAVILY_API_KEY',
    credentialConfigured: true,
    credentialSource: 'env',
    credentialWritable: true,
  },
  extract: {
    id: 'community-tavily',
    endpointHost: 'api.tavily.com',
    credentialRef: 'TAVILY_API_KEY',
    credentialConfigured: true,
    credentialSource: 'env',
    credentialWritable: true,
  },
}

describe('WebConfigView', () => {
  it('shows provider and credential status without accepting a secret value', () => {
    const view = new WebConfigView(status, createTheme(false), vi.fn(), vi.fn())
    const output = view.render(100).join('\n')

    expect(output).toContain('community-tavily · api.tavily.com')
    expect(output.match(/TAVILY_API_KEY configured via env/gu)).toHaveLength(1)
    expect(output).not.toContain('secret')
  })

  it('refreshes in place, closes with Escape, and respects narrow widths', () => {
    const onRefresh = vi.fn()
    const onClose = vi.fn()
    const view = new WebConfigView(status, createTheme(false), onRefresh, onClose)

    view.handleInput('r')
    view.handleInput('\r')
    view.handleInput('\u001b')

    expect(onRefresh).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledOnce()
    expect(view.render(32).every(line => visibleWidth(line) <= 32)).toBe(true)
  })
})
