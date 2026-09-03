import type {
  ModelReasoningEffort,
  SessionModels,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission-presets/client'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/client'
import type { VisionStatus } from '@vascent/deepseek-harness-vision'
import type { CommunityWebStatus } from '@vascent/deepseek-harness-web'

// Load optional projection-key augmentations at this consumer boundary.
import type {} from '@deepseek-ai/dsh-permission-presets/client'
import type {} from '@deepseek-ai/dsh-plan-mode/client'

export interface ConfigurationSnapshot {
  models: SessionModels | undefined
  permissions?: PermissionSelect
  plan?: PlanProjection
  vision?: VisionStatus
  web?: CommunityWebStatus | null
  detailsExpanded: boolean
}

export type ConfigurationRowKind = 'model' | 'reasoning' | 'permissions' | 'plan' | 'vision' | 'web' | 'details'

export interface ConfigurationRow {
  kind: ConfigurationRowKind
  label: string
  value: string
  scope: 'Session' | 'Session + default' | 'TUI'
  available: boolean
}

function hasProjection<K extends keyof SessionProjectionMap>(
  projections: Partial<SessionProjectionMap>,
  key: K,
): projections is Partial<SessionProjectionMap> & Pick<SessionProjectionMap, K> {
  return Object.hasOwn(projections, key)
}

/** Project authoritative Session and capability facts for the Configuration feature. */
export function configurationSnapshot(
  models: SessionModels | undefined,
  projections: Partial<SessionProjectionMap>,
  detailsExpanded: boolean,
  vision?: VisionStatus,
  web?: CommunityWebStatus | null,
): ConfigurationSnapshot {
  return {
    models,
    ...hasProjection(projections, 'permissions') ? { permissions: projections.permissions } : {},
    ...hasProjection(projections, 'plan') ? { plan: projections.plan } : {},
    ...vision === undefined ? {} : { vision },
    ...web === undefined ? {} : { web },
    detailsExpanded,
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

export function configurationRows(snapshot: ConfigurationSnapshot): readonly ConfigurationRow[] {
  const current = snapshot.models?.current
  const webSearch = snapshot.web?.search.providers
    .find(provider => provider.id === snapshot.web?.search.activeProviderId)
  const webExtract = snapshot.web?.extract.providers
    .find(provider => provider.id === snapshot.web?.extract.activeProviderId)
  const webReady = webSearch?.available === true && webExtract?.available === true
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
    scope: 'Session + default',
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
        : `${snapshot.vision.config.mode} · ${snapshot.vision.config.proxyProvider}/${snapshot.vision.config.proxyModel}`,
    scope: 'TUI',
    available: snapshot.vision !== undefined,
  }, {
    kind: 'web',
    label: 'Web',
    value: snapshot.web === undefined
      ? 'Unavailable in this profile'
      : snapshot.web === null
        ? 'Loading provider status…'
        : `${webSearch?.label ?? snapshot.web.search.activeProviderId} search · ${webExtract?.label ?? snapshot.web.extract.activeProviderId} read · ${webReady ? 'ready' : 'configuration required'}`,
    scope: 'TUI',
    available: snapshot.web !== undefined,
  }, {
    kind: 'details',
    label: 'Details',
    value: snapshot.detailsExpanded ? 'expanded' : 'compact',
    scope: 'TUI',
    available: true,
  }]
}

/** Policy-only summary used by the shell status row. */
export function sessionControlSummary(projections: Partial<SessionProjectionMap>): string {
  const snapshot = configurationSnapshot(undefined, projections, false)
  const parts: string[] = []
  if (snapshot.permissions !== undefined) parts.push(snapshot.permissions.currentValue)
  if (snapshot.plan !== undefined && (snapshot.plan.active || snapshot.plan.pending)) {
    parts.push(snapshot.plan.pending
      ? `Plan ${snapshot.plan.active ? 'active' : 'off'} → pending`
      : 'Plan active')
  }
  return parts.join(' · ')
}
