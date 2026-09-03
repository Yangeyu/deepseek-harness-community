import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import { TrajectoryProcess, type TrajectorySnapshot } from './process.ts'
import type { TrajectoryView } from './view.ts'

const IDLE: TrajectorySnapshot = {
  active: false,
  mode: 'list',
  selectedKey: undefined,
  records: 0,
  following: true,
}

/** Stable command facade over the active Session's Trajectory feature. */
export class TrajectoryHost {
  private process: TrajectoryProcess | undefined

  get current(): Readonly<TrajectorySnapshot> { return this.process?.current ?? IDLE }
  get activeView(): TrajectoryView | undefined { return this.process?.activeView }

  bind(process: TrajectoryProcess | undefined, owner?: LifecycleScope): void {
    this.process = process
    if (process !== undefined) owner?.onDispose(() => {
      if (this.process === process) this.process = undefined
    })
  }

  open(): void { this.process?.open() }
}
