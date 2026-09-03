import type { SessionModels } from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { describe, expect, it } from 'vitest'
import {
  configurationRows,
  configurationSnapshot,
  sessionControlSummary,
} from '../../../src/modules/configuration/model.ts'

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
        reasoning: { efforts: [{ id: 'max', name: 'Maximum' }] },
      }],
    }],
    failures: [],
  }
}

describe('configuration model', () => {
  it('keeps absent policy projections distinct from available TUI settings', () => {
    const snapshot = configurationSnapshot(undefined, {}, false)

    expect(snapshot).toEqual({ models: undefined, detailsExpanded: false })
    expect(configurationRows(snapshot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'permissions', available: false }),
      expect.objectContaining({ kind: 'details', available: true, scope: 'TUI' }),
    ]))
  })

  it('renders model, reasoning, policy, and scope from authoritative facts', () => {
    const snapshot = configurationSnapshot(models(), {
      permissions: {
        currentValue: 'workspace-write',
        options: [{ value: 'workspace-write', name: 'Workspace write' }],
      },
      plan: { active: false, pending: true },
    } as Partial<SessionProjectionMap>, true)

    expect(configurationRows(snapshot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'model', value: 'deepseek/v4', scope: 'Session' }),
      expect.objectContaining({ kind: 'reasoning', value: 'Maximum' }),
      expect.objectContaining({ kind: 'permissions', scope: 'Session + default' }),
      expect.objectContaining({ kind: 'plan', value: 'off · pending transition' }),
      expect.objectContaining({ kind: 'details', value: 'expanded', scope: 'TUI' }),
    ]))
  })

  it('distinguishes unavailable, loading, and ready Web providers', () => {
    const loading = configurationSnapshot(undefined, {}, false, undefined, null)
    expect(configurationRows(loading)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'web', available: true, value: 'Loading provider status…' }),
    ]))

    const ready = configurationSnapshot(undefined, {}, false, undefined, {
      search: {
        selection: 'auto',
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
    })
    expect(configurationRows(ready)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'web', value: 'Tavily search · Tavily read · ready' }),
    ]))
  })

  it('summarizes only authoritative permission and Plan state', () => {
    const projections = {
      permissions: {
        currentValue: 'workspace-write',
        options: [{ value: 'workspace-write', name: 'Workspace write' }],
      },
      plan: { active: true, pending: false },
    } as Partial<SessionProjectionMap>

    expect(sessionControlSummary(projections)).toBe('workspace-write · Plan active')
  })
})
