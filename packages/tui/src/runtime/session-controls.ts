import type {
  ModelReasoningEffort,
  SessionModels,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission-presets/client'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/client'
import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { VisionStatus } from '@vascent/deepseek-harness-vision'
import type { CommunityWebStatus } from '@vascent/deepseek-harness-web'
import { keymapShortcut, type KeymapPreset } from '../input/keymap.ts'

// Load optional projection-key augmentations at the client boundary only.
import type {} from '@deepseek-ai/dsh-permission-presets/client'
import type {} from '@deepseek-ai/dsh-plan-mode/client'
import type {} from '@deepseek-ai/dsh-goal/client'
import type {} from '@deepseek-ai/dsh-tool-todo/client'

export interface ConfigurationSnapshot {
  models: SessionModels | undefined
  permissions?: PermissionSelect
  plan?: PlanProjection
  vision?: VisionStatus
  web?: CommunityWebStatus | null
  keymap: KeymapPreset
  detailsExpanded: boolean
}

export interface TaskSnapshot {
  goal?: GoalProjection | null
  todos?: TodoItem[] | null
  running: boolean
  queued: number
}

export type ConfigurationRowKind = 'model' | 'reasoning' | 'permissions' | 'plan' | 'vision' | 'web' | 'keymap' | 'details'
export type TaskRowKind = 'goal' | 'todos' | 'runtime'

export interface ControlRow<Kind extends string> {
  kind: Kind
  label: string
  value: string
  scope: 'Session' | 'TUI'
  available: boolean
}

function hasProjection<K extends keyof SessionProjectionMap>(
  projections: Partial<SessionProjectionMap>,
  key: K,
): projections is Partial<SessionProjectionMap> & Pick<SessionProjectionMap, K> {
  return Object.hasOwn(projections, key)
}

/** Read current configuration values without introducing a second state store. */
export function configurationSnapshot(
  models: SessionModels | undefined,
  projections: Partial<SessionProjectionMap>,
  detailsExpanded: boolean,
  vision?: VisionStatus,
  keymap: KeymapPreset = 'standard',
  web?: CommunityWebStatus | null,
): ConfigurationSnapshot {
  return {
    models,
    ...hasProjection(projections, 'permissions') ? { permissions: projections.permissions } : {},
    ...hasProjection(projections, 'plan') ? { plan: projections.plan } : {},
    ...vision === undefined ? {} : { vision },
    ...web === undefined ? {} : { web },
    keymap,
    detailsExpanded,
  }
}

/** Read task lifecycle and progress from the active Host state. */
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

export function reasoningEfforts(snapshot: ConfigurationSnapshot): readonly ModelReasoningEffort[] {
  const current = snapshot.models?.current
  if (current === undefined) return []
  return snapshot.models?.groups.find(group => group.id === current.provider)
    ?.models.find(model => model.id === current.model)
    ?.reasoning?.efforts ?? []
}

function reasoningValue(snapshot: ConfigurationSnapshot): string {
  const current = snapshot.models?.current
  if (current === undefined) return 'Loading model state…'
  const efforts = reasoningEfforts(snapshot)
  if (efforts.length === 0) return 'Unavailable for this model'
  if (current.reasoningEffort === undefined) return 'Provider default'
  return efforts.find(effort => effort.id === current.reasoningEffort)?.name ?? current.reasoningEffort
}

/** Stable rows for the unified configuration center. */
export function configurationRows(
  snapshot: ConfigurationSnapshot,
): readonly ControlRow<ConfigurationRowKind>[] {
  const current = snapshot.models?.current
  const webProviders = snapshot.web === null || snapshot.web === undefined
    ? undefined
    : [...new Set([snapshot.web.search.id, snapshot.web.extract.id])].join(' + ')
  return [{
    kind: 'model',
    label: 'Model',
    value: current === undefined ? 'Loading model state…' : `${current.provider}/${current.model}`,
    scope: 'Session',
    available: current !== undefined,
  }, {
    kind: 'reasoning',
    label: 'Reasoning',
    value: reasoningValue(snapshot),
    scope: 'Session',
    available: reasoningEfforts(snapshot).length > 0,
  }, {
    kind: 'permissions',
    label: 'Permission',
    value: snapshot.permissions?.currentValue ?? 'Unavailable in this profile',
    scope: 'Session',
    available: snapshot.permissions !== undefined,
  }, {
    kind: 'plan',
    label: 'Plan Mode',
    value: snapshot.plan === undefined
      ? 'Unavailable in this profile'
      : `${snapshot.plan.active ? 'active' : 'off'}${snapshot.plan.pending ? ' · pending transition' : ''}`,
    scope: 'Session',
    available: snapshot.plan !== undefined,
  }, {
    kind: 'vision',
    label: 'Vision',
    value: snapshot.vision === undefined
      ? 'Unavailable in this profile'
      : snapshot.vision.config.mode === 'disabled'
        ? 'disabled'
        : `${snapshot.vision.config.mode} · ${snapshot.vision.config.proxyProvider}/${snapshot.vision.config.proxyModel}${snapshot.vision.credentialConfigured === false ? ' · credential missing' : ''}`,
    scope: 'TUI',
    available: snapshot.vision !== undefined,
  }, {
    kind: 'web',
    label: 'Web',
    value: snapshot.web === undefined
      ? 'Unavailable in this profile'
      : snapshot.web === null
        ? 'Loading provider status…'
        : [snapshot.web.search, snapshot.web.extract].every(provider => provider.credentialConfigured)
          ? `${webProviders} · ready`
          : `${webProviders} · credential missing`,
    scope: 'TUI',
    available: snapshot.web !== undefined,
  }, {
    kind: 'keymap',
    label: 'Keybindings',
    value: `${snapshot.keymap} · ${keymapShortcut(snapshot.keymap, 'turn.queue') ?? 'unbound'} queues while working`,
    scope: 'TUI',
    available: true,
  }, {
    kind: 'details',
    label: 'Details',
    value: snapshot.detailsExpanded ? 'expanded' : 'compact',
    scope: 'TUI',
    available: true,
  }]
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

/** Stable rows for current task state and lifecycle. */
export function taskRows(snapshot: TaskSnapshot): readonly ControlRow<TaskRowKind>[] {
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

/** Compact status for the fixed composer row; unavailable capabilities disappear. */
export function sessionControlSummary(projections: Partial<SessionProjectionMap>): string {
  const config = configurationSnapshot(undefined, projections, false)
  const task = taskSnapshot(projections, false, 0)
  const parts: string[] = []
  if (config.permissions !== undefined) parts.push(config.permissions.currentValue)
  if (config.plan !== undefined && (config.plan.active || config.plan.pending)) {
    parts.push(config.plan.pending ? `Plan ${config.plan.active ? 'active' : 'off'} → pending` : 'Plan active')
  }
  if (task.goal !== undefined && task.goal !== null) {
    parts.push(`Goal ${task.goal.goal.phase} ${task.goal.roundsStarted}/${task.goal.goal.maxGoalRounds}`)
  }
  if (task.todos !== undefined && task.todos !== null && task.todos.length > 0) {
    const completed = task.todos.filter(item => item.status === 'completed').length
    parts.push(`Tasks ${completed}/${task.todos.length}`)
  }
  return parts.join(' · ')
}
