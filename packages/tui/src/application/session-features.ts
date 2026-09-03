import type { PromptContentPart } from '../runtime/session/contracts.ts'
import type { LifecycleScope } from '../runtime/lifecycle/scope.ts'
import type { SessionOperation } from '../runtime/lifecycle/session-machine.ts'
import type {
  SessionFeatureContext,
  SessionFeatureParticipant,
} from '../runtime/session/features.ts'
import type { SessionManager } from '../runtime/session/manager.ts'
import type { PreparedPrompt, PromptPreparationContext } from '../runtime/session/prompt.ts'
import type { RuntimeSessionSnapshot, SessionId } from '../runtime/session/snapshot.ts'
import type { ComposerProcess } from '../modules/composer/process.ts'
import type { ComposerHost } from '../modules/composer/host.ts'
import type { InteractionProcess } from '../modules/interaction/process.ts'
import type { InteractionHost } from '../modules/interaction/host.ts'
import type { SkillsProcess } from '../modules/skills/process.ts'
import type { SkillsHost } from '../modules/skills/host.ts'
import type { TaskProcess } from '../modules/task/process.ts'
import type { TaskHost } from '../modules/task/host.ts'
import type { TrajectoryProcess } from '../modules/trajectory/process.ts'
import type { TrajectoryHost } from '../modules/trajectory/host.ts'
import type { TranscriptProcess } from '../modules/transcript/process.ts'
import type { TranscriptHost } from '../modules/transcript/host.ts'

export interface SessionFeatureSet {
  readonly scope: LifecycleScope
  readonly composer: ComposerProcess
  readonly interaction: InteractionProcess
  readonly skills: SkillsProcess
  readonly task: TaskProcess
  readonly trajectory: TrajectoryProcess
  readonly transcript: TranscriptProcess
  readonly identity?: { readonly sessionId: SessionId; readonly epoch: number }
}

export interface SessionFeatureHosts {
  readonly composer: ComposerHost
  readonly interaction: InteractionHost
  readonly skills: SkillsHost
  readonly task: TaskHost
  readonly trajectory: TrajectoryHost
  readonly transcript: TranscriptHost
}

export type SessionFeatureFactory = (
  context: SessionFeatureContext,
  previous: SessionFeatureSet | undefined,
) => SessionFeatureSet

/**
 * Pins reads and subscriptions to one Session epoch while delegating commands
 * through the manager's epoch-checked boundaries.
 */
export class BoundSession {
  private snapshot: Readonly<RuntimeSessionSnapshot>

  constructor(
    private readonly manager: SessionManager,
    private readonly scope: LifecycleScope,
    readonly sessionId: SessionId,
    readonly epoch: number,
    initial: Readonly<RuntimeSessionSnapshot>,
  ) {
    this.snapshot = initial
  }

  get current(): Readonly<RuntimeSessionSnapshot> { return this.snapshot }

  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void {
    return this.manager.subscribe((snapshot) => {
      if (!this.scope.active || !this.matches(snapshot)) return
      this.snapshot = snapshot
      listener(snapshot)
    })
  }

  prompt(text: string, mode: 'queue' | 'steer', content?: PromptContentPart[]): Promise<void> {
    this.assertVisible()
    return this.manager.prompt(text, mode, content)
  }

  promptWithPreparation(
    text: string,
    mode: 'queue' | 'steer',
    prepareContent: (context: PromptPreparationContext) => Promise<PreparedPrompt>,
  ): Promise<void> {
    this.assertVisible()
    return this.manager.promptWithPreparation(text, mode, prepareContent)
  }

  loadEarlierHistory(): Promise<boolean> {
    this.assertVisible()
    return this.manager.loadEarlierHistory()
  }

  cancel(): Promise<void> {
    this.assertVisible()
    return this.manager.cancel()
  }

  answerApproval(...args: Parameters<SessionManager['answerApproval']>): Promise<void> {
    this.assertVisible()
    return this.manager.answerApproval(...args)
  }

  answerQuestions(...args: Parameters<SessionManager['answerQuestions']>): Promise<void> {
    this.assertVisible()
    return this.manager.answerQuestions(...args)
  }

  openPath(path: string, signal: AbortSignal): Promise<void> {
    this.assertActive()
    return this.manager.openPath(path, signal)
  }

  notice(message: string): void {
    if (this.scope.active && this.matches(this.manager.current)) this.manager.notice(message)
  }

  private matches(snapshot: Readonly<RuntimeSessionSnapshot>): boolean {
    return snapshot.sessionId === this.sessionId && snapshot.execution.epoch === this.epoch
  }

  private assertActive(): void {
    if (!this.scope.active) throw new Error('the owning Session scope has retired')
  }

  private assertVisible(): void {
    this.assertActive()
    if (!this.matches(this.manager.current)) throw new Error('the active Session changed')
  }
}

/** Swaps the whole statically composed Session feature set at one lifecycle boundary. */
export class SessionFeatureCoordinator implements SessionFeatureParticipant {
  private visible: SessionFeatureSet | undefined
  private suspended: SessionFeatureSet | undefined

  constructor(
    private readonly hosts: SessionFeatureHosts,
    bootstrap: SessionFeatureSet,
    private readonly create: SessionFeatureFactory,
  ) {
    this.visible = bootstrap
    this.install(bootstrap)
  }

  prepare(operation: SessionOperation<SessionId>): void {
    if (operation.presentation !== 'empty' || this.suspended !== undefined) return
    this.suspended = this.visible
    this.visible = undefined
    this.install(undefined)
  }

  activate(context: SessionFeatureContext): void {
    const previous = this.visible ?? this.suspended
    let next: SessionFeatureSet
    try {
      next = this.create(context, previous)
    } catch (error: unknown) {
      this.visible = undefined
      this.suspended = undefined
      this.install(undefined)
      if (previous !== undefined) void previous.scope.dispose()
      throw error
    }
    this.visible = next
    this.suspended = undefined
    this.install(next)
    if (previous !== undefined && previous !== next) void previous.scope.dispose()
  }

  rollback(operation: SessionOperation<SessionId>): void {
    if (operation.presentation !== 'empty') return
    this.visible = this.suspended
    this.suspended = undefined
    this.install(this.visible)
  }

  fail(operation: SessionOperation<SessionId>): void {
    this.rollback(operation)
  }

  private install(features: SessionFeatureSet | undefined): void {
    const scope = features?.scope
    this.hosts.composer.bind(features?.composer, scope)
    this.hosts.interaction.bind(features?.interaction, scope)
    this.hosts.skills.bind(features?.skills, scope)
    this.hosts.task.bind(features?.task, scope)
    this.hosts.trajectory.bind(features?.trajectory, scope)
    this.hosts.transcript.bind(features?.transcript, features?.identity, scope)
  }
}
