import { randomUUID } from 'node:crypto'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type {
  PromptContentPart,
  ModelCatalog,
  SessionRequestId,
  SessionSummary,
} from './contracts.ts'
// Merge the Web composer's projection keys into SessionProjectionMap.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { LifecycleScope } from '../lifecycle/scope.ts'
import type { SessionRuntime } from './runtime.ts'
import type { RuntimeSessionSnapshot, SessionId } from './snapshot.ts'
import { SessionWorkspace } from './workspace.ts'
import type { SessionEffectScope } from './effect-scope.ts'
import type {
  SessionControlFrame,
  SessionTransport,
} from './transport.ts'
import type { SubmissionActivityUpdate } from './submission.ts'
import type { PreparedPrompt, PromptPreparationContext } from './prompt.ts'
import { selectedModel } from './model-selection.ts'
import type {
  ApprovalPrompt,
  QuestionPrompt,
  SessionInteractionSource,
  SessionInteractionEvent,
  SessionInteractionListener,
} from './interactions.ts'
import type { SessionFeatureParticipant } from './features.ts'

export type { PendingSubmission } from './submission.ts'
export type { RuntimeSessionSnapshot } from './snapshot.ts'

/** Module-neutral request to replace the active Session at one durable boundary. */
export interface SessionForkRequest {
  readonly sessionId: string
  readonly previousTurnEndSeq?: number
}

type PendingHostInteraction =
  | {
      readonly kind: 'approval'
      readonly prompt: ApprovalPrompt
      readonly resolve: (outcome: ApprovalOutcome) => void
      readonly reject: (error: unknown) => void
      readonly removeAbort: () => void
    }
  | {
      readonly kind: 'questions'
      readonly prompt: QuestionPrompt
      readonly resolve: (answer: AskUserQuestionAnswer) => void
      readonly reject: (error: unknown) => void
      readonly removeAbort: () => void
    }

function terminalTimeZone(): string | undefined {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return zone.trim() === '' ? undefined : zone
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Session and stream coordinator over the transport-neutral Harness API. */
export class SessionManager {
  private readonly connectionScope: LifecycleScope
  private readonly workspace: SessionWorkspace
  private readonly interactionListeners = new Set<SessionInteractionListener>()
  private readonly pendingInteractions = new Map<string, PendingHostInteraction>()
  private readonly historyPages = new WeakMap<SessionRuntime, Promise<boolean>>()
  private started = false

  constructor(
    private readonly scope: LifecycleScope,
    private readonly transport: SessionTransport,
    private readonly interactionSource: SessionInteractionSource,
    cwd: string,
    private readonly historyMessages: number,
  ) {
    this.connectionScope = scope.fork('host-connection')
    this.workspace = new SessionWorkspace(scope.fork('workspace'), cwd)
    scope.onDispose(() => { this.retireInteractions(new Error('terminal interaction owner disposed')) })
  }

  /** Current immutable-by-convention state snapshot. */
  get current(): Readonly<RuntimeSessionSnapshot> {
    return this.workspace.current
  }

  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void {
    return this.workspace.subscribe(listener)
  }

  /** Register the statically composed Session feature set with the replacement transaction. */
  registerFeatureParticipant(participant: SessionFeatureParticipant): () => void {
    return this.workspace.registerFeatureParticipant(participant)
  }

  onInteraction(listener: SessionInteractionListener): () => void {
    this.interactionListeners.add(listener)
    return () => { this.interactionListeners.delete(listener) }
  }

  captureSession(): SessionEffectScope {
    const runtime = this.requireRuntime()
    const workspace = this.workspace
    return {
      sessionId: runtime.sessionId,
      epoch: runtime.epoch,
      get active() { return workspace.owns(runtime) },
      commitModelCatalog(catalog) {
        if (!workspace.owns(runtime)) return false
        runtime.setModelCatalog(catalog)
        return true
      },
    }
  }

  /** Bind Host signals, create or resume the initial Session, then attach control state. */
  async start(resumeSessionId?: string): Promise<void> {
    if (this.started) throw new Error('SessionManager has already started')
    this.started = true
    this.connectionScope.onDispose(this.transport.onStatus((sessionId, running) => {
      this.workspace.runtimeFor(sessionId)?.setRunState(running ? 'running' : 'idle')
    }))
    this.connectionScope.onDispose(this.transport.onError((sessionId, message) => {
      this.workspace.runtimeFor(sessionId)?.setError(message)
    }))
    this.connectionScope.onDispose(this.interactionSource.connect({
      approval: prompt => this.requestApproval(prompt),
      questions: prompt => this.requestQuestions(prompt),
    }))
    await this.openSession(resumeSessionId)
    void this.runControlLoop()
  }

  /** Stop stream reads and reject further Session work. */
  dispose(): Promise<void> {
    return this.scope.dispose()
  }

  /** Publish a transient terminal-only notice. */
  notice(message: string): void {
    this.workspace.notice(message)
  }

  /** List resumable session rows for a terminal selector. */
  async sessions(): Promise<SessionSummary[]> {
    return [...await this.transport.listSessions()]
  }

  /** Prepend one older, message-aligned history page without disturbing live tail events. */
  async loadEarlierHistory(): Promise<boolean> {
    const runtime = this.requireRuntime()
    const pending = this.historyPages.get(runtime)
    if (pending !== undefined) return pending
    const task = this.readEarlierPage(runtime)
    this.historyPages.set(runtime, task)
    try {
      return await task
    } finally {
      this.historyPages.delete(runtime)
    }
  }

  private async readEarlierPage(runtime: SessionRuntime): Promise<boolean> {
    const beforeSeq = runtime.current.events.at(0)?.event.seq
    const throughSeq = runtime.historyCursor
    if (!runtime.current.historyHasMore || beforeSeq === undefined || throughSeq === undefined) return false
    const page = await this.transport.page({
      sessionId: runtime.sessionId,
      throughSeq,
      beforeSeq,
      maxMessages: this.historyMessages,
    }, runtime.signal)
    if (!this.workspace.owns(runtime)) return false
    return runtime.prependHistory(page)
  }

  /** Switch the terminal to a fresh session in the current working directory. */
  async newSession(): Promise<void> {
    await this.openSession()
  }

  /** Clear the visible conversation immediately, then attach a fresh session. */
  async clearSession(): Promise<void> {
    await this.openSession(undefined, true)
  }

  /** Switch the terminal to an existing persisted or live session. */
  async resume(sessionId: string): Promise<void> {
    await this.openSession(sessionId)
  }

  /** Fork to the selected turn boundary, then open and return the replacement session. */
  async rewind(request: SessionForkRequest, onPhase?: (phase: 'forking' | 'opening') => void): Promise<SessionId> {
    const source = this.requireSession()
    if (String(source) !== request.sessionId) throw new Error('the active session changed before rewind')
    onPhase?.('forking')
    let target: SessionId
    if (request.previousTurnEndSeq === undefined) {
      const created = await this.transport.createSession({ cwd: this.current.cwd })
      target = created.sessionId
      const selection = selectedModel(this.current.modelCatalog, this.current.projections)
      if (selection !== undefined) {
        await this.transport.selectModel(target, {
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        })
      }
    } else {
      target = (await this.transport.forkSession({
        sessionId: source,
        atSeq: request.previousTurnEndSeq,
      })).sessionId
    }
    onPhase?.('opening')
    await this.openSession(String(target))
    return target
  }

  /** Submit ordinary text using the caller-selected queue placement. */
  async prompt(
    text: string,
    mode: 'queue' | 'steer',
    content: PromptContentPart[] = [{ type: 'text', text }],
  ): Promise<void> {
    await this.submitPrompt(text, mode, content)
  }

  /** Publish a prompt immediately while an attachment pipeline prepares one atomic admission. */
  async promptWithPreparation(
    text: string,
    mode: 'queue' | 'steer',
    prepareContent: (context: PromptPreparationContext) => Promise<PreparedPrompt>,
  ): Promise<void> {
    await this.submitPrompt(text, mode, prepareContent)
  }

  private async submitPrompt(
    text: string,
    mode: 'queue' | 'steer',
    contentOrPreparation: PromptContentPart[] | ((context: PromptPreparationContext) => Promise<PreparedPrompt>),
  ): Promise<void> {
    const runtime = this.requireRuntime()
    const pending = runtime.startSubmission(text, mode)
    if (pending === undefined) throw new Error('the active session is no longer available')
    const rejectPending = (): void => {
      if (this.workspace.owns(runtime)) runtime.rejectSubmission(pending.key)
    }
    const setActivity = (activity: SubmissionActivityUpdate): void => {
      if (this.workspace.owns(runtime)) runtime.setSubmissionActivity(pending.key, activity)
    }
    const clientTimeZone = terminalTimeZone()
    const requestId = randomUUID() as SessionRequestId
    try {
      const prepared = typeof contentOrPreparation === 'function'
        ? await contentOrPreparation({ setActivity })
        : { kind: 'content' as const, content: contentOrPreparation }
      if (!this.workspace.visible(runtime)) {
        throw new Error('The active session changed while preparing the prompt.')
      }
      if (prepared.kind === 'admission') {
        await prepared.commit({
          requestId,
          ...clientTimeZone === undefined ? {} : { clientTimeZone },
        })
        if (!this.workspace.owns(runtime)) return
        runtime.acceptSubmission(pending.key, requestId)
        return
      }
      const response = await this.transport.prompt({
        requestId,
        sessionId: runtime.sessionId,
        mode,
        content: prepared.content,
        ...clientTimeZone === undefined ? {} : { clientTimeZone },
      }, runtime.signal)
      if (!this.workspace.owns(runtime)) return
      runtime.acceptSubmission(pending.key, response.requestId)
    } catch (error: unknown) {
      rejectPending()
      throw error
    }
  }

  /** Hand a local authoring file to the Host platform opener when available. */
  async openPath(path: string, signal: AbortSignal): Promise<void> {
    await this.transport.openPath(path, signal)
  }

  /** Cancel the active turn while preserving pending queued work. */
  async cancel(): Promise<void> {
    const runtime = this.requireRuntime()
    const previous = runtime.current.runState
    if (previous === 'running') runtime.setRunState('interrupting')
    try {
      await this.transport.cancel(runtime.sessionId)
    } catch (error: unknown) {
      if (this.workspace.owns(runtime)) runtime.setRunState(previous)
      throw error
    }
  }

  /** Settle one Host approval waterfall owned by this terminal. */
  async answerApproval(prompt: ApprovalPrompt, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const pending = this.pendingInteractions.get(prompt.requestId)
    if (pending?.kind !== 'approval' || pending.prompt !== prompt) {
      throw new Error('approval request is no longer answerable')
    }
    this.pendingInteractions.delete(prompt.requestId)
    pending.removeAbort()
    pending.resolve(outcome)
    this.publishInteraction({
      type: 'resolved',
      resolution: {
        type: 'approval/resolved',
        sessionId: prompt.sessionId,
        requestId: prompt.requestId,
        outcome,
      },
    })
  }

  /** Settle one Host question waterfall owned by this terminal. */
  async answerQuestions(
    prompt: QuestionPrompt,
    answers: Array<{ id: string; selected: string[]; custom?: string }>,
  ): Promise<void> {
    const pending = this.pendingInteractions.get(prompt.requestId)
    if (pending?.kind !== 'questions' || pending.prompt !== prompt) {
      throw new Error('question request is no longer answerable')
    }
    this.pendingInteractions.delete(prompt.requestId)
    pending.removeAbort()
    pending.resolve({ answers })
    this.publishInteraction({
      type: 'resolved',
      resolution: {
        type: 'question/resolved',
        sessionId: prompt.sessionId,
        requestId: prompt.requestId,
        outcome: 'answered',
      },
    })
  }

  private requireSession(): SessionId {
    return this.requireRuntime().sessionId
  }

  private requireRuntime(): SessionRuntime {
    const runtime = this.workspace.active
    if (runtime === undefined) throw new Error('no terminal session is active')
    return runtime
  }

  private async openSession(resumeSessionId?: string, clearImmediately = false): Promise<void> {
    const previous = this.current
    const operation = this.workspace.begin(clearImmediately ? 'empty' : 'previous')
    let committed = false
    try {
      const host = await this.transport.describeHost()
      let cwd = previous.cwd || host.cwd
      let requested: SessionId | undefined
      let requestedRunning = false
      if (resumeSessionId !== undefined) {
        const summary = (await this.transport.listSessions())
          .find(item => String(item.sessionId) === resumeSessionId)
        if (summary === undefined) throw new Error(`session "${resumeSessionId}" was not found`)
        requested = summary.sessionId
        requestedRunning = summary.running
        cwd = summary.cwd ?? host.cwd
      }
      const created = await this.transport.createSession({
        cwd,
        ...requested === undefined ? {} : { sessionId: requested },
      })
      const commit = this.workspace.commit(operation, {
        sessionId: created.sessionId,
        cwd,
        connection: this.current.connection,
      })
      if (commit === undefined) return
      committed = true
      this.retireInteractions(new Error('the active Session changed'))
      await commit.retirement
      if (commit.activationError !== undefined) throw commit.activationError
      if (requestedRunning) commit.runtime.setRunState('running')
      await this.startFollow(commit.runtime)
      await this.refreshRuntimeModels(commit.runtime).catch((error: unknown) => {
        if (this.workspace.owns(commit.runtime)) {
          commit.runtime.setError(`model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (committed) this.workspace.setError(message)
      else this.workspace.fail(operation, message)
      throw error
    }
  }

  private async refreshRuntimeModels(runtime: SessionRuntime): Promise<ModelCatalog> {
    const catalog = await this.transport.modelCatalog()
    if (this.workspace.owns(runtime)) runtime.setModelCatalog(catalog)
    return catalog
  }

  private startFollow(runtime: SessionRuntime): Promise<void> {
    const opening = Promise.withResolvers<void>()
    void this.runFollowLoop(runtime, opening)
    return opening.promise
  }

  private async runFollowLoop(
    runtime: SessionRuntime,
    opening: PromiseWithResolvers<void>,
  ): Promise<void> {
    const followScope = runtime.forkScope('history-follow')
    let opened = false
    while (followScope.active) {
      try {
        let snapshotSeen = false
        for await (const frame of this.transport.follow(
          runtime.sessionId,
          this.historyMessages,
          followScope.signal,
        )) {
          if (!this.workspace.owns(runtime)) return
          runtime.setConnection('events', 'online', undefined)
          if (frame.type === 'snapshot') {
            runtime.hydrate(frame.page, frame.cursor, frame.assistantStream)
            snapshotSeen = true
            if (!opened) {
              opened = true
              opening.resolve()
            }
            continue
          }
          if (!snapshotSeen) throw new Error('Session follow stream emitted an event before its snapshot')
          if (frame.type === 'assistant-stream') {
            runtime.acceptAssistantFrame(frame.frame)
            continue
          }
          if (runtime.appendEvent(frame.entry) === 'gap') {
            throw new Error('Session follow stream contained a sequence gap')
          }
        }
        if (followScope.active) throw new Error('Session follow stream ended unexpectedly')
      } catch (error: unknown) {
        if (!followScope.active || !this.workspace.owns(runtime)) return
        const message = error instanceof Error ? error.message : String(error)
        runtime.setConnection('events', 'reconnecting', `event stream disconnected: ${message}`)
        if (!opened) {
          opening.reject(error)
          return
        }
      }
      await abortableDelay(500, followScope.signal)
    }
  }

  private async runControlLoop(): Promise<void> {
    while (this.connectionScope.active) {
      try {
        for await (const frame of this.transport.control(this.connectionScope.signal)) {
          this.workspace.setConnection('control', 'online', undefined)
          this.handleControl(frame)
        }
        if (this.connectionScope.active) throw new Error('Session control stream ended unexpectedly')
      } catch (error: unknown) {
        if (!this.connectionScope.active) return
        this.workspace.setConnection('control', 'reconnecting', `control stream disconnected: ${String(error)}`)
      }
      await abortableDelay(500, this.connectionScope.signal)
    }
  }

  private handleControl(frame: SessionControlFrame): void {
    if (frame.type === 'baseline') {
      const runtime = this.workspace.active
      if (runtime === undefined) return
      runtime.setQueue(frame.queues[String(runtime.sessionId)] ?? [])
      const projections = frame.projections[String(runtime.sessionId)]
      if (projections !== undefined) runtime.applyProjectionBaseline(projections)
      return
    }
    const runtime = this.workspace.runtimeFor(frame.sessionId)
    if (runtime === undefined) return
    if (frame.type === 'queue') {
      runtime.setQueue(frame.items)
      return
    }
    if (frame.type === 'projection') {
      runtime.applyProjection(frame.key, frame.value, frame.seq)
    }
  }

  private requestApproval(prompt: ApprovalPrompt): Promise<ApprovalOutcome | undefined> {
    if (!this.ownsInteraction(prompt.sessionId)) return Promise.resolve(undefined)
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const removeAbort = this.observeInteractionAbort(prompt, reject)
      this.pendingInteractions.set(prompt.requestId, {
        kind: 'approval', prompt, resolve, reject, removeAbort,
      })
      this.publishInteraction({ type: 'approval', prompt })
    })
  }

  private requestQuestions(prompt: QuestionPrompt): Promise<AskUserQuestionAnswer | undefined> {
    if (!this.ownsInteraction(prompt.sessionId)) return Promise.resolve(undefined)
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const removeAbort = this.observeInteractionAbort(prompt, reject)
      this.pendingInteractions.set(prompt.requestId, {
        kind: 'questions', prompt, resolve, reject, removeAbort,
      })
      this.publishInteraction({ type: 'questions', prompt })
    })
  }

  private ownsInteraction(sessionId: SessionId): boolean {
    const runtime = this.workspace.runtimeFor(sessionId)
    return runtime !== undefined && this.workspace.visible(runtime)
  }

  private observeInteractionAbort(
    prompt: ApprovalPrompt | QuestionPrompt,
    reject: (error: unknown) => void,
  ): () => void {
    const signal = prompt.signal
    if (signal === undefined) return () => {}
    const onAbort = (): void => {
      const pending = this.pendingInteractions.get(prompt.requestId)
      if (pending === undefined) return
      this.pendingInteractions.delete(prompt.requestId)
      reject(signal.reason ?? new Error('Host interaction was cancelled'))
      this.publishInteraction({
        type: 'resolved',
        resolution: 'questions' in prompt
          ? {
              type: 'question/resolved',
              sessionId: prompt.sessionId,
              requestId: prompt.requestId,
              outcome: 'cancelled',
            }
          : {
              type: 'approval/resolved',
              sessionId: prompt.sessionId,
              requestId: prompt.requestId,
              outcome: 'cancelled',
            },
      })
    }
    if (signal.aborted) queueMicrotask(onAbort)
    else signal.addEventListener('abort', onAbort, { once: true })
    return () => { signal.removeEventListener('abort', onAbort) }
  }

  private retireInteractions(error: Error): void {
    for (const pending of this.pendingInteractions.values()) {
      pending.removeAbort()
      pending.reject(error)
    }
    this.pendingInteractions.clear()
  }

  private publishInteraction(event: SessionInteractionEvent): void {
    for (const listener of this.interactionListeners) listener(event)
  }
}
