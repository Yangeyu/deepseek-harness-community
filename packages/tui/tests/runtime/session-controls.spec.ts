import type { SessionModels } from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { describe, expect, it } from 'vitest'
import {
  configurationRows,
  configurationSnapshot,
  sessionControlSummary,
  taskRows,
  taskSnapshot,
} from '../../src/runtime/session-controls.ts'

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

describe('session control selectors', () => {
  it('separates configurable policy from task state and preserves empty projections', () => {
    const projections = { goal: null, todos: null } as Partial<SessionProjectionMap>
    const config = configurationSnapshot(undefined, projections, false)
    const task = taskSnapshot(projections, false, 0)

    expect(config).toEqual({ models: undefined, keymap: 'standard', detailsExpanded: false })
    expect(task).toEqual({ goal: null, todos: null, running: false, queued: 0 })
    expect(configurationRows(config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'permissions', available: false }),
      expect.objectContaining({ kind: 'keymap', value: 'standard · Tab queues while working' }),
      expect.objectContaining({ kind: 'details', available: true, scope: 'TUI' }),
    ]))
    expect(taskRows(task)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'goal', available: true, value: 'No goal' }),
      expect.objectContaining({ kind: 'todos', available: true, value: 'No tasks' }),
      expect.objectContaining({ kind: 'runtime', value: 'idle' }),
    ]))
  })

  it('renders model, reasoning, policy, and scope in the configuration rows', () => {
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
      expect.objectContaining({ kind: 'plan', value: 'off · pending transition' }),
      expect.objectContaining({ kind: 'details', value: 'expanded', scope: 'TUI' }),
    ]))
  })

  it('distinguishes unavailable, loading, and configured Web status', () => {
    const loading = configurationSnapshot(undefined, {}, false, undefined, 'standard', null)
    expect(configurationRows(loading)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'web', available: true, value: 'Loading provider status…' }),
    ]))

    const ready = configurationSnapshot(undefined, {}, false, undefined, 'standard', {
      search: {
        id: 'community-brave',
        credentialRef: 'BRAVE_API_KEY',
        credentialConfigured: true,
        credentialWritable: true,
      },
      extract: {
        id: 'community-tavily',
        credentialRef: 'TAVILY_API_KEY',
        credentialConfigured: true,
        credentialWritable: true,
      },
    })
    expect(configurationRows(ready)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'web',
        available: true,
        value: 'community-brave + community-tavily · ready',
      }),
    ]))
  })

  it('summarizes authoritative policy and task state without copying it', () => {
    const projections = {
      permissions: {
        currentValue: 'workspace-write',
        options: [{ value: 'workspace-write', name: 'Workspace write' }],
      },
      plan: { active: true, pending: false },
      goal: {
        goal: {
          id: 'goal-1' as never,
          revision: 2,
          objective: 'Ship the TUI',
          phase: 'active',
          maxGoalRounds: 8,
        },
        roundsStarted: 2,
        createdAt: 1,
        updatedAt: 2,
      },
      todos: [
        { content: 'Design', status: 'completed' },
        { content: 'Implement', status: 'in_progress' },
        { content: 'Release', status: 'pending' },
      ],
    } as Partial<SessionProjectionMap>

    expect(sessionControlSummary(projections)).toBe(
      'workspace-write · Plan active · Goal active 2/8 · Tasks 1/3',
    )
    expect(taskRows(taskSnapshot(projections, true, 2))).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'todos', value: '1/3 completed · 1 in progress' }),
      expect.objectContaining({ kind: 'runtime', value: 'running · 2 queued' }),
    ]))
  })
})
