import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'

// Load optional projection-key augmentations at this consumer boundary.
import type {} from '@deepseek-ai/dsh-goal/client'
import type {} from '@deepseek-ai/dsh-tool-todo/client'

export interface TaskSnapshot {
  goal?: GoalProjection | null
  todos?: TodoItem[] | null
  running: boolean
  queued: number
}

export type TaskRowKind = 'goal' | 'todos' | 'runtime'

export interface TaskRow {
  kind: TaskRowKind
  label: string
  value: string
  scope: 'Session'
  available: boolean
}

function hasProjection<K extends keyof SessionProjectionMap>(
  projections: Partial<SessionProjectionMap>,
  key: K,
): projections is Partial<SessionProjectionMap> & Pick<SessionProjectionMap, K> {
  return Object.hasOwn(projections, key)
}

export function taskSnapshot(
  projections: Partial<SessionProjectionMap>,
  running: boolean,
  queued: number,
): TaskSnapshot {
  return {
    ...hasProjection(projections, 'goal') ? { goal: projections.goal } : {},
    ...hasProjection(projections, 'todos') ? { todos: projections.todos } : {},
    running,
    queued,
  }
}

function goalValue(projection: GoalProjection | null | undefined): string {
  if (projection === undefined) return 'Unavailable in this profile'
  if (projection === null) return 'No goal'
  const { goal, roundsStarted } = projection
  const rounds = `${roundsStarted}/${goal.maxGoalRounds} rounds`
  if (goal.phase === 'blocked') return `blocked · ${rounds} · ${goal.blockedReason?.message ?? 'reason unavailable'}`
  return `${goal.phase} · ${rounds}`
}

function todoValue(todos: TodoItem[] | null | undefined): string {
  if (todos === undefined) return 'Unavailable in this profile'
  if (todos === null || todos.length === 0) return 'No tasks'
  const completed = todos.filter(item => item.status === 'completed').length
  const active = todos.filter(item => item.status === 'in_progress').length
  return `${completed}/${todos.length} completed${active === 0 ? '' : ` · ${active} in progress`}`
}

export function taskRows(snapshot: TaskSnapshot): readonly TaskRow[] {
  return [{
    kind: 'goal',
    label: 'Goal',
    value: goalValue(snapshot.goal),
    scope: 'Session',
    available: snapshot.goal !== undefined,
  }, {
    kind: 'todos',
    label: 'Tasks',
    value: todoValue(snapshot.todos),
    scope: 'Session',
    available: snapshot.todos !== undefined,
  }, {
    kind: 'runtime',
    label: 'Runtime',
    value: `${snapshot.running ? 'running' : 'idle'}${snapshot.queued === 0 ? '' : ` · ${snapshot.queued} queued`}`,
    scope: 'Session',
    available: true,
  }]
}

/** Goal and task counters used by the shell identity row. */
export function goalTaskSummary(projections: Partial<SessionProjectionMap>): string {
  const task = taskSnapshot(projections, false, 0)
  const parts: string[] = []
  if (task.goal !== undefined && task.goal !== null) {
    parts.push(`Goal ${task.goal.goal.phase} ${task.goal.roundsStarted}/${task.goal.goal.maxGoalRounds}`)
  }
  if (task.todos !== undefined && task.todos !== null && task.todos.length > 0) {
    const completed = task.todos.filter(item => item.status === 'completed').length
    parts.push(`Tasks ${completed}/${task.todos.length}`)
  }
  return parts.join(' · ')
}
