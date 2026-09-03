import { Text, type Component } from '@earendil-works/pi-tui'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import { ScopedEffectRunner } from '../../runtime/dispatch/effect-runner.ts'
import type { ComposerDraft } from '../composer/input.ts'
import type { AttachmentDraft } from '../composer/attachments/drafts.ts'
import {
  RewindTransaction,
  type RewindAction,
  type RewindConversationPort,
  type RewindPlan,
  type RewindPointSummary,
  type RewindPort,
} from './index.ts'
import {
  preparePromptDraft,
  type PromptAttachmentReader,
} from './application/prompt-draft.ts'
import { RewindDialog, RewindPointDialog } from './view/index.ts'

export interface RewindSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  notice(message: string): void
}

export interface RewindComposerPort {
  restoreDraft(draft: ComposerDraft<AttachmentDraft>): void
  disarmRewind(): void
}

export interface RewindSurfaceHandle {
  replace(descriptor: RewindSurfaceDescriptor): boolean
  close(): boolean
}

export interface RewindSurfaceDescriptor {
  readonly placement: 'readable'
  readonly component: Component
  readonly focus?: Component | null
}

export interface RewindSurfacePort {
  readonly active: boolean
  open(descriptor: RewindSurfaceDescriptor): RewindSurfaceHandle
}

export interface RewindProcessOptions {
  readonly rewind: RewindPort
  readonly conversation: RewindConversationPort
  readonly session: RewindSessionPort
  readonly composer: RewindComposerPort
  readonly surfaces: RewindSurfacePort
  readonly promptAttachments?: PromptAttachmentReader
  readonly visibleRows: () => number
  readonly theme: TuiTheme
  readonly scope: LifecycleScope
}

export interface RewindSnapshot {
  readonly phase: 'idle' | 'loading' | 'selecting' | 'planning' | 'restoring'
  readonly points: number
}

/** Owns the application-level Rewind workflow that spans source and replacement Sessions. */
export class RewindProcess {
  private readonly transaction: RewindTransaction
  private readonly effects: ScopedEffectRunner
  private progress: Text | undefined
  private summaries: RewindPointSummary[] | undefined
  private pointDialog: RewindPointDialog | undefined
  private surface: RewindSurfaceHandle | undefined
  private phase: RewindSnapshot['phase'] = 'idle'
  private operation: Promise<void> | undefined

  constructor(private readonly options: RewindProcessOptions) {
    this.transaction = new RewindTransaction(options.rewind, options.conversation)
    this.effects = new ScopedEffectRunner(options.scope, (error) => {
      options.session.notice(error instanceof Error ? error.message : String(error))
    })
    options.scope.onDispose(async () => { await this.operation })
    options.scope.onDispose(() => { this.close() })
  }

  get current(): Readonly<RewindSnapshot> {
    return { phase: this.phase, points: this.summaries?.length ?? 0 }
  }

  request(): void {
    this.options.composer.disarmRewind()
    void this.run(() => this.open())
  }

  async open(): Promise<void> {
    if (this.options.surfaces.active) return
    const sessionId = this.options.session.current.sessionId
    if (sessionId === undefined) throw new Error('no terminal session is active')
    this.phase = 'loading'
    this.showProgress('Loading Rewind history…')
    try {
      this.summaries = await this.transaction.list(
        String(sessionId),
        this.options.session.current.cwd,
      )
      if (this.options.session.current.sessionId !== sessionId) {
        throw new Error('the active session changed while Rewind was preparing')
      }
    } catch (error: unknown) {
      this.close()
      throw error
    }
    this.showPointList()
  }

  perform(plan: RewindPlan, action: RewindAction = 'code-and-conversation'): Promise<void> {
    if (this.operation !== undefined) return this.operation
    const operation = this.execute(plan, action).finally(() => {
      if (this.operation === operation) this.operation = undefined
    })
    this.operation = operation
    return operation
  }

  private async execute(plan: RewindPlan, action: RewindAction): Promise<void> {
    this.phase = 'restoring'
    try {
      const draft = action === 'code-only'
        ? undefined
        : await preparePromptDraft(plan.input, this.options.promptAttachments)
      await this.transaction.execute(plan, action, (phase) => {
        this.showProgress(phase === 'forking'
          ? 'Rewinding conversation…'
          : phase === 'opening'
            ? 'Reloading rewound session…'
            : 'Rewind failed; restoring the current workspace and memory…')
      })
      if (draft !== undefined) this.options.composer.restoreDraft(draft)
    } catch (error: unknown) {
      this.options.session.notice(error instanceof Error ? error.message : String(error))
    } finally {
      this.close()
    }
  }

  private showPointList(selectedPointId?: string): void {
    const summaries = this.summaries
    if (summaries === undefined) return
    this.phase = 'selecting'
    const dialog = new RewindPointDialog(
      summaries,
      selectedPointId,
      this.options.visibleRows,
      this.options.theme,
      summary => { void this.openPlan(summary) },
      () => { this.close() },
    )
    this.pointDialog = dialog
    this.progress = undefined
    this.showComponent(dialog)
  }

  private async openPlan(summary: RewindPointSummary): Promise<void> {
    const sessionId = this.options.session.current.sessionId
    if (sessionId === undefined || String(sessionId) !== summary.sessionId) {
      this.close()
      this.options.session.notice('The active session changed before the rewind point could be inspected.')
      return
    }
    this.phase = 'planning'
    this.showProgress('Preparing source-attributed restore plan…')
    let plan: RewindPlan
    try {
      plan = await this.transaction.plan(String(sessionId), summary.pointId)
    } catch (error: unknown) {
      this.close()
      this.options.session.notice(error instanceof Error ? error.message : String(error))
      return
    }
    const dialog = new RewindDialog(
      plan,
      this.options.visibleRows,
      this.options.theme,
      (action) => {
        this.showProgress(action === 'conversation-only'
          ? 'Restoring conversation checkpoint…'
          : action === 'code-only'
            ? 'Restoring source-attributed code state…'
            : 'Restoring code and conversation checkpoint…')
        void this.perform(plan, action)
      },
      () => { this.showPointList(summary.pointId) },
    )
    this.pointDialog = undefined
    this.showComponent(dialog)
  }

  private showProgress(message: string): void {
    this.progress ??= new Text('', 1, 0)
    this.pointDialog = undefined
    this.progress.setText([
      this.options.theme.bold('Rewind'),
      this.options.theme.accent(`✦ ${message}`),
      this.options.theme.dim('Source-attributed workspace, Memory, and conversation state stay coordinated.'),
    ].join('\n'))
    this.showComponent(this.progress, null)
  }

  private showComponent(component: Component, focus: Component | null = component): void {
    if (!this.options.scope.active) return
    const descriptor = { placement: 'readable' as const, component, focus }
    if (this.surface?.replace(descriptor) === true) return
    this.surface = this.options.surfaces.open(descriptor)
  }

  private close(): void {
    this.surface?.close()
    this.surface = undefined
    this.progress = undefined
    this.summaries = undefined
    this.pointDialog = undefined
    this.phase = 'idle'
  }

  private async run(action: () => Promise<void>): Promise<void> {
    await this.effects.run(async () => { await action() })
  }
}
