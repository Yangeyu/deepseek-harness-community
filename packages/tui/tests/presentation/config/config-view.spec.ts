import type { SessionModels } from '@deepseek-ai/dsh-host-apiproxy'
import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { ConfigView } from '../../../src/presentation/config/config-view.ts'
import { createTheme } from '../../../src/presentation/theme.ts'

function models(): SessionModels {
  return {
    current: { provider: 'deepseek', model: 'v4', reasoningEffort: 'max' },
    routable: true,
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{
        id: 'v4',
        name: 'V4',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Maximum' }] },
      }],
    }],
    failures: [],
  }
}

function snapshot() {
  return {
    models: models(),
    permissions: {
      currentValue: 'workspace-write',
      options: [
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Unrestricted', description: 'Full host access.' },
        { value: 'custom', name: 'Custom' },
      ],
    },
    plan: { active: false, pending: false },
    web: {
      search: {
        selection: 'auto' as const,
        activeProviderId: 'community-tavily',
        providers: [{
          id: 'community-tavily',
          label: 'Tavily',
          description: 'Search through Tavily.',
          credentialRef: 'TAVILY_API_KEY',
          credentialConfigured: true,
          credentialWritable: true,
          available: true,
        }],
      },
      extract: {
        activeProviderId: 'community-tavily',
        providers: [{
          id: 'community-tavily',
          label: 'Tavily',
          description: 'Read pages through Tavily.',
          credentialRef: 'TAVILY_API_KEY',
          credentialConfigured: true,
          credentialWritable: true,
          available: true,
        }],
      },
    },
    detailsExpanded: false,
  }
}

function view(overrides: {
  onReasoning?: (effort: string | undefined) => void
  onPermission?: (value: string) => void
  onDetails?: (expanded: boolean) => void
  onWeb?: () => void
  onClose?: () => void
} = {}, initialStage: 'root' | 'reasoning' | 'permissions' | 'plan' = 'root') {
  return new ConfigView(
    snapshot(),
    createTheme(false),
    vi.fn(),
    overrides.onReasoning ?? vi.fn(),
    overrides.onPermission ?? vi.fn(),
    vi.fn(),
    overrides.onDetails ?? vi.fn(),
    overrides.onClose ?? vi.fn(),
    initialStage,
    undefined,
    overrides.onWeb,
  )
}

describe('ConfigView', () => {
  it('presents one scoped configuration center with vim navigation', () => {
    const config = view()

    const initial = config.render(80).join('\n')
    expect(initial).toContain('Config')
    expect(initial).toContain('› Model')
    expect(initial).toContain('Session')
    config.handleInput('j')
    expect(config.render(80).join('\n')).toContain('› Reasoning')
    config.handleInput('G')
    expect(config.render(80).join('\n')).toContain('› Details')
    config.handleInput('g')
    expect(config.render(80).join('\n')).toContain('› Model')
  })

  it('selects reasoning effort without routing through model input', () => {
    const onReasoning = vi.fn()
    const config = view({ onReasoning })

    config.handleInput('j')
    config.handleInput('\r')
    expect(config.render(80).join('\n')).toContain('Reasoning Effort')
    config.handleInput('\r')
    expect(onReasoning).toHaveBeenCalledWith(undefined)
  })

  it('requires confirmation before applying unrestricted permission', () => {
    const onPermission = vi.fn()
    const config = view({ onPermission }, 'permissions')

    config.handleInput('j')
    config.handleInput('\r')
    const confirmation = config.render(80).join('\n')
    expect(confirmation).toContain('Confirm unrestricted access')
    expect(confirmation).toContain('remembered for newly created sessions')
    expect(onPermission).not.toHaveBeenCalled()
    config.handleInput('\r')
    expect(onPermission).toHaveBeenCalledWith('danger-full-access')
  })

  it('allows the effective permission to be reaffirmed as the new-session default', () => {
    const onPermission = vi.fn()
    const config = view({ onPermission }, 'permissions')

    config.handleInput('\r')

    expect(onPermission).toHaveBeenCalledWith('workspace-write')
  })

  it('toggles terminal details and closes direct section entry on Escape', () => {
    const onDetails = vi.fn()
    const onClose = vi.fn()
    const config = view({ onDetails, onClose })

    config.handleInput('G')
    config.handleInput('\r')
    expect(onDetails).toHaveBeenCalledWith(true)

    const direct = view({ onClose }, 'permissions')
    direct.handleInput('\u001b')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('opens the Web provider surface from the unified Config list', () => {
    const onWeb = vi.fn()
    const config = view({ onWeb })

    for (let index = 0; index < 5; index += 1) config.handleInput('j')
    config.handleInput('\r')

    expect(onWeb).toHaveBeenCalledOnce()
  })

  it('bounds every rendered row in narrow terminals', () => {
    const config = view()

    expect(config.render(32).every(line => visibleWidth(line) <= 32)).toBe(true)
    config.handleInput('j')
    config.handleInput('\r')
    expect(config.render(32).every(line => visibleWidth(line) <= 32)).toBe(true)
  })
})
