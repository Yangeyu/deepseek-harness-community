import type { Component } from '@earendil-works/pi-tui'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { TrajectoryView } from './view.ts'

export interface TrajectorySessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void
  loadEarlierHistory(): Promise<boolean>
  cancel(): Promise<void>
  notice(message: string): void
}

export interface TrajectorySurfaceHandle {
  close(): boolean
}

export interface TrajectorySurfacePort {
  readonly active: boolean
  open(descriptor: { readonly placement: 'workspace'; readonly component: Component }): TrajectorySurfaceHandle
}

export interface TrajectoryProcessOptions {
  readonly session: TrajectorySessionPort
  readonly surfaces: TrajectorySurfacePort
  readonly visibleRows: () => number
  readonly theme: TuiTheme
  readonly invalidate: () => void
  readonly scope: LifecycleScope
}

export interface TrajectorySnapshot {
  readonly active: boolean
  readonly mode: 'list' | 'detail'
  readonly selectedKey: string | undefined
  readonly records: number
  readonly following: boolean
}

/** Owns the execution ledger's session projection and workspace surface. */
export class TrajectoryProcess {
  private view: TrajectoryView | undefined
  private surface: TrajectorySurfaceHandle | undefined

  constructor(private readonly options: TrajectoryProcessOptions) {
    options.scope.onDispose(options.session.subscribe(snapshot => {
      this.view?.setState(snapshot)
    }))
    options.scope.onDispose(() => { this.close() })
  }

  get activeView(): TrajectoryView | undefined {
    return this.view
  }

  get current(): Readonly<TrajectorySnapshot> {
    return this.view === undefined
      ? { active: false, mode: 'list', selectedKey: undefined, records: 0, following: true }
      : { active: true, ...this.view.snapshot }
  }

  open(): void {
    if (this.options.surfaces.active) return
    const view = new TrajectoryView(
      this.options.session.current,
      this.options.visibleRows,
      this.options.theme,
      () => this.options.session.loadEarlierHistory(),
      () => { void this.run(() => this.options.session.cancel()) },
      () => { this.close() },
      this.options.invalidate,
      this.options.scope.fork('trajectory-view'),
    )
    this.view = view
    this.surface = this.options.surfaces.open({ placement: 'workspace', component: view })
  }

  private close(): void {
    this.surface?.close()
    this.surface = undefined
    void this.view?.dispose()
    this.view = undefined
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error: unknown) {
      this.options.session.notice(error instanceof Error ? error.message : String(error))
    }
  }
}
