import type { SkillEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { SkillCatalogSnapshot } from './catalog.ts'
import { SkillsProcess } from './process.ts'
import type { SkillsView } from './view/catalog-view.ts'

const EMPTY: SkillCatalogSnapshot = { entries: [], status: 'idle' }

/** Stable catalog/command facade over the active Session's Skills process. */
export class SkillsHost {
  private process: SkillsProcess | undefined

  get current(): Readonly<SkillCatalogSnapshot> { return this.process?.current ?? EMPTY }
  get activeView(): SkillsView | undefined { return this.process?.activeView }

  bind(process: SkillsProcess | undefined, owner?: LifecycleScope): void {
    this.process = process
    if (process !== undefined) owner?.onDispose(() => {
      if (this.process === process) this.process = undefined
    })
  }

  refresh(force = false): Promise<readonly SkillEntry[]> {
    return this.process?.refresh(force) ?? Promise.resolve([])
  }

  open(): void { this.process?.open() }
}
