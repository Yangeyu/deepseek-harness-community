import type { Component } from '@earendil-works/pi-tui'
import type { MemoryActivity } from '@vascent/deepseek-harness-memory'
import { MemoryDialog } from './view.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import type { MemoryPort } from './contracts.ts'

export interface MemorySessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
}

export interface MemorySurfaceHandle {
  close(): boolean
}

export interface MemorySurfacePort {
  readonly active: boolean
  open(descriptor: { readonly placement: 'readable'; readonly component: Component }): MemorySurfaceHandle
}

export interface MemoryProcessOptions {
  readonly memory: MemoryPort
  readonly session: MemorySessionPort
  readonly surfaces: MemorySurfacePort
  readonly visibleRows: () => number
  readonly theme: TuiTheme
  readonly onActivity: () => void
  readonly scope: LifecycleScope
}

/** Owns memory-learning activity and the session policy surface. */
export class MemoryProcess {
  private memoryActivity: MemoryActivity = { state: 'idle' }

  constructor(private readonly options: MemoryProcessOptions) {
    options.scope.onDispose(options.memory.onActivity((activity) => {
      if (!options.scope.active) return
      this.memoryActivity = activity
      options.onActivity()
    }))
  }

  get activity(): Readonly<MemoryActivity> {
    return this.memoryActivity
  }

  async open(): Promise<void> {
    if (this.options.surfaces.active) return
    const state = this.options.session.current
    if (state.sessionId === undefined) throw new Error('no terminal session is active')
    const sessionId = String(state.sessionId)
    const overview = await this.options.memory.overview(state.cwd, sessionId)
    if (!this.options.scope.active || this.options.surfaces.active) return
    let surface!: MemorySurfaceHandle
    const close = (): void => { surface.close() }
    const dialog = new MemoryDialog(
      overview,
      this.options.visibleRows,
      this.options.theme,
      policy => { this.options.memory.setPolicy(sessionId, policy) },
      close,
    )
    surface = this.options.surfaces.open({ placement: 'readable', component: dialog })
  }
}
