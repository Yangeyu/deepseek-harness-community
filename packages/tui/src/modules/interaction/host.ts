import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import {
  InteractionProcess,
  type InteractionSnapshot,
} from './process.ts'
import type {
  ApprovalPrompt,
  InteractionResolution,
  QuestionPrompt,
} from '../../runtime/session/interactions.ts'

const IDLE: InteractionSnapshot = { activeKey: undefined, phase: 'idle', queued: 0 }

/** Application-stable command facade over the active Session's interaction process. */
export class InteractionHost {
  private process: InteractionProcess | undefined

  get current(): Readonly<InteractionSnapshot> { return this.process?.current ?? IDLE }
  get active(): boolean { return this.process?.active ?? false }
  get activeKey(): string | undefined { return this.process?.activeKey }

  bind(process: InteractionProcess | undefined, owner?: LifecycleScope): void {
    this.process = process
    if (process !== undefined) owner?.onDispose(() => {
      if (this.process === process) this.process = undefined
    })
  }

  requestApproval(prompt: ApprovalPrompt): void { this.process?.requestApproval(prompt) }
  requestQuestions(prompt: QuestionPrompt): void { this.process?.requestQuestions(prompt) }
  resolve(resolution: InteractionResolution): void { this.process?.resolve(resolution) }
  cancel(): boolean { return this.process?.cancel() ?? false }
}
