import type { Component } from '@earendil-works/pi-tui'
import type { MemoryActivity, MemorySessionPolicy } from '@vascent/deepseek-harness-memory'
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
  readonly invalidate: () => void
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
    let policy: MemorySessionPolicy | undefined = overview.policy
    const close = (): void => { surface.close() }
    const savePolicy = async (patch: Partial<MemorySessionPolicy>): Promise<void> => {
      if (!this.options.scope.active) return
      dialog.setPolicy({ value: policy, saving: true })
      this.options.invalidate()
      let failure: string | undefined
      try {
        policy = await this.options.memory.setPolicy(sessionId, patch)
      } catch (error: unknown) {
        if (!this.options.scope.active) return
        failure = error instanceof Error ? error.message : String(error)
        try {
          policy = await this.options.memory.policy(sessionId)
        } catch (readError: unknown) {
          policy = undefined
          failure += `\nUnable to read current memory policy: ${readError instanceof Error ? readError.message : String(readError)}`
        }
      }
      if (!this.options.scope.active) return
      dialog.setPolicy({ value: policy, saving: false, ...failure === undefined ? {} : { error: failure } })
      this.options.invalidate()
    }
    const dialog = new MemoryDialog(
      overview,
      this.options.visibleRows,
      this.options.theme,
      patch => { void savePolicy(patch) },
      close,
    )
    surface = this.options.surfaces.open({ placement: 'readable', component: dialog })
  }
}
