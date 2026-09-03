import type { Component } from '@earendil-works/pi-tui'

/** Semantic keyboard capabilities advertised by the currently focused Surface. */
export type SurfaceInputContext =
  | 'approval'
  | 'choice'
  | 'memory'
  | 'menu'
  | 'model-menu'
  | 'multi-select'
  | 'rewind-confirm'
  | 'rewind-point'
  | 'skills'
  | 'text-input'
  | 'trajectory'
  | 'web-menu'

/** Feature-facing actions resolved by the shell's one fixed binding table. */
export type SurfaceInputAction =
  | 'surface.back'
  | 'surface.cancel'
  | 'surface.collapse'
  | 'surface.confirm'
  | 'surface.create'
  | 'surface.detail-next'
  | 'surface.detail-previous'
  | 'surface.edit'
  | 'surface.expand'
  | 'surface.first'
  | 'surface.half-page-next'
  | 'surface.half-page-previous'
  | 'surface.interrupt-or-cancel'
  | 'surface.last'
  | 'surface.next'
  | 'surface.page-next'
  | 'surface.page-previous'
  | 'surface.previous'
  | 'surface.refresh'
  | 'surface.search'
  | 'surface.select-1'
  | 'surface.select-2'
  | 'surface.select-3'
  | 'surface.select-4'
  | 'surface.select-5'
  | 'surface.select-6'
  | 'surface.select-7'
  | 'surface.select-8'
  | 'surface.select-9'
  | 'surface.tab-next'
  | 'surface.tab-previous'
  | 'surface.toggle'

export interface SurfaceInputTarget extends Component {
  readonly inputContext: SurfaceInputContext
  handleAction(action: SurfaceInputAction): void
}

export function isSurfaceInputTarget(component: Component | null): component is SurfaceInputTarget {
  if (component === null || typeof component !== 'object') return false
  const candidate = component as Partial<SurfaceInputTarget>
  return typeof candidate.inputContext === 'string' && typeof candidate.handleAction === 'function'
}

export function isSurfaceInputAction(action: string): action is SurfaceInputAction {
  return action.startsWith('surface.')
}
