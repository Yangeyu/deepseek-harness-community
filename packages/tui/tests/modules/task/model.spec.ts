import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { describe, expect, it } from 'vitest'
import {
  goalTaskSummary,
  taskRows,
  taskSnapshot,
} from '../../../src/modules/task/model.ts'

describe('task model', () => {
  it('preserves empty Goal and Todo projections as available empty state', () => {
    const snapshot = taskSnapshot({ goal: null, todos: null } as Partial<SessionProjectionMap>, false, 0)

    expect(snapshot).toEqual({ goal: null, todos: null, running: false, queued: 0 })
    expect(taskRows(snapshot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'goal', available: true, value: 'No goal' }),
      expect.objectContaining({ kind: 'todos', available: true, value: 'No tasks' }),
      expect.objectContaining({ kind: 'runtime', value: 'idle' }),
    ]))
  })

  it('summarizes task progress and runtime without copying state', () => {
    const projections = {
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

    expect(goalTaskSummary(projections)).toBe('Goal active 2/8 · Tasks 1/3')
    expect(goalTaskSummary({})).toBe('')
    expect(taskRows(taskSnapshot(projections, true, 2))).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'todos', value: '1/3 completed · 1 in progress' }),
      expect.objectContaining({ kind: 'runtime', value: 'running · 2 queued' }),
    ]))
  })
})
