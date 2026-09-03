import type { Component } from '@earendil-works/pi-tui'
import type { LifecycleScope } from '../../../runtime/lifecycle/scope.ts'
import {
  isSurfaceInputTarget,
  type SurfaceInputAction,
  type SurfaceInputContext,
  type SurfaceInputTarget,
} from '../../primitives/surface-input.ts'
import type { ActiveSurface, ComposerAnchoredLayout } from '../layout/composer-layout.ts'

export interface SurfaceScreen {
  getFocusedComponent(): Component | null
  setFocus(component: Component | null): void
}

export interface SurfaceDescriptor {
  readonly placement: ActiveSurface['kind']
  readonly component: Component
  readonly focus?: Component | null
}

export interface SurfaceHandle {
  readonly active: boolean
  replace(surface: SurfaceDescriptor): boolean
  close(): boolean
}

export interface SurfaceSnapshot {
  readonly depth: number
  readonly active: {
    readonly id: number
    readonly placement: ActiveSurface['kind']
    readonly inputContext: SurfaceInputContext | undefined
  } | undefined
}

export interface FocusSnapshot {
  readonly surfaceOwned: boolean
  readonly restorePending: boolean
}

interface SurfaceEntry {
  readonly id: number
  readonly scope: LifecycleScope
  surface: SurfaceDescriptor
}

/** One stack owns surface placement, focus capture, replacement, and restoration. */
export class SurfaceHost {
  private readonly stack: SurfaceEntry[] = []
  private nextId = 0
  private baseFocus: Component | null = null

  constructor(
    private readonly layout: ComposerAnchoredLayout,
    private readonly screen: SurfaceScreen,
    private readonly invalidate: () => void,
    private readonly scope: LifecycleScope,
  ) {
    scope.onDispose(() => {
      this.stack.splice(0)
      this.layout.setActiveSurface(undefined)
      this.baseFocus = null
    })
  }

  get active(): boolean {
    return this.stack.length > 0
  }

  get inputContext(): SurfaceInputContext | undefined {
    return this.inputTarget()?.inputContext
  }

  get current(): Readonly<SurfaceSnapshot> {
    const active = this.stack.at(-1)
    return {
      depth: this.stack.length,
      active: active === undefined
        ? undefined
        : {
            id: active.id,
            placement: active.surface.placement,
            inputContext: this.inputTarget()?.inputContext,
          },
    }
  }

  get focus(): Readonly<FocusSnapshot> {
    return {
      surfaceOwned: this.stack.length > 0,
      restorePending: this.baseFocus !== null,
    }
  }

  dispatchInput(action: SurfaceInputAction): boolean {
    const target = this.inputTarget()
    if (target === undefined) return false
    target.handleAction(action)
    if (action === 'surface.page-previous') this.layout.pageSurface(-1)
    else if (action === 'surface.page-next') this.layout.pageSurface(1)
    else if (action === 'surface.previous') this.layout.scrollSurface(-1)
    else if (action === 'surface.next') this.layout.scrollSurface(1)
    this.invalidate()
    return true
  }

  scroll(direction: -1 | 1): boolean {
    const changed = this.layout.scrollSurface(direction)
    if (changed) this.invalidate()
    return changed
  }

  open(surface: SurfaceDescriptor): SurfaceHandle {
    if (!this.scope.active) throw new Error('Cannot open a surface in an inactive SurfaceHost.')
    if (this.stack.length === 0) this.baseFocus = this.screen.getFocusedComponent()
    const entry: SurfaceEntry = {
      id: ++this.nextId,
      scope: this.scope.fork(`surface-${String(this.nextId)}`),
      surface,
    }
    this.stack.push(entry)
    entry.scope.onDispose(() => { this.retire(entry) })
    this.applyActiveSurface()
    return {
      get active() { return entry.scope.active },
      replace: next => this.replace(entry, next),
      close: () => this.close(entry),
    }
  }

  private replace(entry: SurfaceEntry, surface: SurfaceDescriptor): boolean {
    if (!entry.scope.active) return false
    entry.surface = surface
    if (this.stack.at(-1) === entry) this.applyActiveSurface()
    return true
  }

  private close(entry: SurfaceEntry): boolean {
    if (!entry.scope.active) return false
    void entry.scope.dispose()
    return true
  }

  private retire(entry: SurfaceEntry): void {
    const index = this.stack.indexOf(entry)
    if (index < 0) return
    const wasActive = index === this.stack.length - 1
    this.stack.splice(index, 1)
    if (wasActive && this.scope.active) this.applyActiveSurface()
  }

  private applyActiveSurface(): void {
    const active = this.stack.at(-1)
    if (active === undefined) {
      this.layout.setActiveSurface(undefined)
      this.screen.setFocus(this.baseFocus)
      this.baseFocus = null
    } else {
      this.layout.setActiveSurface({
        kind: active.surface.placement,
        component: active.surface.component,
      })
      this.screen.setFocus(active.surface.focus === undefined
        ? active.surface.component
        : active.surface.focus)
    }
    this.invalidate()
  }

  private inputTarget(): SurfaceInputTarget | undefined {
    const active = this.stack.at(-1)?.surface
    if (active === undefined) return undefined
    const focused = active.focus === undefined ? active.component : active.focus
    return isSurfaceInputTarget(focused) ? focused : undefined
  }
}
