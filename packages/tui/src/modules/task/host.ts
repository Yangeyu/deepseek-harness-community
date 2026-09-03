import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { TaskSnapshot } from './model.ts'
import { TaskProcess } from './process.ts'
import type { TaskView } from './view.ts'

const EMPTY: TaskSnapshot = { running: false, queued: 0 }

/** Stable command facade over the active Session's Task feature. */
export class TaskHost {
  private process: TaskProcess | undefined

  get current(): Readonly<TaskSnapshot> { return this.process?.current ?? EMPTY }
  get activeView(): TaskView | undefined { return this.process?.activeView }

  bind(process: TaskProcess | undefined, owner?: LifecycleScope): void {
    this.process = process
    if (process !== undefined) owner?.onDispose(() => {
      if (this.process === process) this.process = undefined
    })
  }

  open(): void { this.process?.open() }
}
