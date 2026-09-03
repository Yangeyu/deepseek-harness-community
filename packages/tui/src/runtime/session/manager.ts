import { randomUUID } from 'node:crypto'
import type {
  HostFrame,
  PromptContentPart,
  SessionModels,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
// Merge the Web composer's projection keys into SessionProjectionMap.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { LifecycleScope } from '../lifecycle/scope.ts'
import type { SessionRuntime } from './runtime.ts'
import type { RuntimeSessionSnapshot, SessionId } from './snapshot.ts'
import { SessionWorkspace } from './workspace.ts'
import type { SessionEffectScope } from './effect-scope.ts'
import type { SessionMuxRequest, SessionTransport } from './transport.ts'
import type { SubmissionActivityUpdate } from './submission.ts'
import type { PreparedPrompt, PromptPreparationContext } from './prompt.ts'
import type {
  ApprovalPrompt,
  QuestionPrompt,
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

  constructor(
    private readonly scope: LifecycleScope,
    private readonly transport: SessionTransport,
    cwd: string,
    private readonly historyMessages: number,
  ) {
    this.connectionScope = scope.fork('host-connection')
    this.workspace = new SessionWorkspace(scope.fork('workspace'), cwd)
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
      commitModels(models) {
        if (!workspace.owns(runtime)) return false
        runtime.setModels(models)
        return true
      },
      commitModelSelection(selection) {
        if (!workspace.owns(runtime)) return false
        runtime.selectModel(selection)
        return true
      },
    }
  }

  /** Create or resume the initial session, then attach both event streams. */
  async start(resumeSessionId?: string): Promise<void> {
    await this.openSession(resumeSessionId)
    void this.runMuxLoop()
    void this.runHostLoop()
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
    const beforeSeq = runtime.current.events.at(0)?.event.seq
    if (!runtime.current.historyHasMore || beforeSeq === undefined) return false
    const page = await this.transport.history({
      sessionId: runtime.sessionId,
      beforeSeq,
      maxMessages: this.historyMessages,
    })
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
      const selection = this.current.models?.current
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
    let response: Awaited<ReturnType<SessionTransport['prompt']>>
    try {
      const prepared = typeof contentOrPreparation === 'function'
        ? await contentOrPreparation({ setActivity })
        : { kind: 'content' as const, content: contentOrPreparation }
      if (!this.workspace.visible(runtime)) {
        throw new Error('The active session changed while preparing the prompt.')
      }
      if (prepared.kind === 'admission') {
        const externalRpcId = RpcId(randomUUID())
        await prepared.commit({
          rpcId: externalRpcId,
          ...clientTimeZone === undefined ? {} : { clientTimeZone },
        })
        if (!this.workspace.owns(runtime)) return
        runtime.acceptSubmission(pending.key, externalRpcId)
        return
      }
      response = await this.transport.prompt({
        sessionId: runtime.sessionId,
        mode,
        content: prepared.content,
        ...clientTimeZone === undefined ? {} : { clientTimeZone },
      })
    } catch (error: unknown) {
      rejectPending()
      throw error
    }
    if (!this.workspace.owns(runtime)) return
    if (response.command !== undefined) {
      runtime.settleSubmission(pending.key)
      return
    }
    runtime.acceptSubmission(pending.key, response.rpcId)
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

  /** Answer one approval request through the response leg of the RPC protocol. */
  async answerApproval(prompt: ApprovalPrompt, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    await this.respond(prompt.rpcId, {
      sessionId: prompt.sessionId,
      approvalId: prompt.approvalId,
      outcome,
    })
  }

  /** Answer a complete question batch through the response leg of the RPC protocol. */
  async answerQuestions(
    prompt: QuestionPrompt,
    answers: Array<{ id: string; selected: string[]; custom?: string }>,
  ): Promise<void> {
    await this.respond(prompt.rpcId, {
      sessionId: prompt.sessionId,
      answer: { answers },
    })
  }

  private async respond(rpcId: RpcId, value: unknown): Promise<void> {
    await this.transport.respond(rpcId, value)
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
      if (resumeSessionId !== undefined) {
        const summary = (await this.transport.listSessions())
          .find(item => String(item.sessionId) === resumeSessionId)
        if (summary === undefined) throw new Error(`session "${resumeSessionId}" was not found`)
        requested = summary.sessionId
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
      await commit.retirement
      if (commit.activationError !== undefined) throw commit.activationError
      await Promise.all([
        this.resync(commit.runtime),
        this.refreshRuntimeModels(commit.runtime).catch(() => undefined),
      ])
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (committed) this.workspace.setError(message)
      else this.workspace.fail(operation, message)
      throw error
    }
  }

  private async resync(runtime: SessionRuntime = this.requireRuntime()): Promise<void> {
    await runtime.resync(async () => this.transport.history({
      sessionId: runtime.sessionId,
      maxMessages: this.historyMessages,
    }))
  }

  private async refreshRuntimeModels(runtime: SessionRuntime): Promise<SessionModels> {
    const models = await this.transport.models(runtime.sessionId)
    if (this.workspace.owns(runtime)) runtime.setModels(models)
    return models
  }

  private async runMuxLoop(): Promise<void> {
    while (this.connectionScope.active) {
      try {
        for await (const request of this.transport.mux(this.connectionScope.signal)) {
          this.workspace.setConnection('mux', 'online', undefined)
          await this.handleMux(request)
        }
      } catch (error: unknown) {
        if (!this.connectionScope.active) return
        this.workspace.setConnection('mux', 'reconnecting', `event stream disconnected: ${String(error)}`)
      }
      if (!this.connectionScope.active) return
      this.workspace.setConnection('mux', 'reconnecting')
      await abortableDelay(500, this.connectionScope.signal)
      await this.resync().catch(() => undefined)
    }
  }

  private async runHostLoop(): Promise<void> {
    while (this.connectionScope.active) {
      try {
        for await (const frame of this.transport.host(this.connectionScope.signal)) {
          this.workspace.setConnection('host', 'online', undefined)
          this.handleHost(frame)
        }
      } catch (error: unknown) {
        if (!this.connectionScope.active) return
        this.workspace.setConnection('host', 'reconnecting')
        this.workspace.setError(`host stream disconnected: ${String(error)}`)
      }
      if (!this.connectionScope.active) return
      this.workspace.setConnection('host', 'reconnecting')
      await abortableDelay(500, this.connectionScope.signal)
    }
  }

  private async handleMux(request: SessionMuxRequest): Promise<void> {
    const frame = request.payload
    if (frame.type === 'stream/error') {
      this.workspace.setConnection('mux', 'reconnecting')
      this.workspace.setError(frame.error.message)
      return
    }
    const runtime = this.workspace.runtimeFor(frame.sessionId)
    if (runtime === undefined) return
    if (frame.type === 'approval/requested') {
      if (this.workspace.visible(runtime)) {
        this.publishInteraction({ type: 'approval', prompt: { ...frame, rpcId: request.rpcId } })
      }
      return
    }
    if (frame.type === 'question/requested') {
      if (this.workspace.visible(runtime)) {
        this.publishInteraction({ type: 'questions', prompt: { ...frame, rpcId: request.rpcId } })
      }
      return
    }
    switch (frame.type) {
      case 'session/event': {
        const result = runtime.appendEvent({
          event: frame.event,
          ...frame.view === undefined ? {} : { view: frame.view },
        })
        if (result === 'gap') await this.resync(runtime)
        return
      }
      case 'session/subscribed': {
        const last = runtime.current.events.at(-1)?.event.seq ?? -1
        if (frame.lastSeq !== last) await this.resync(runtime)
        return
      }
      case 'session/queue':
        runtime.setQueue(frame.items)
        return
      case 'session/projection':
        runtime.applyProjection(frame.key, frame.value, frame.seq)
        return
      case 'approval/resolved':
      case 'question/resolved':
        if (this.workspace.visible(runtime)) {
          this.publishInteraction({ type: 'resolved', resolution: frame })
        }
        return
      case 'session/jobs':
        return
    }
  }

  private handleHost(frame: HostFrame): void {
    if (frame.type === 'stream/error') {
      this.workspace.setConnection('host', 'reconnecting')
      this.workspace.setError(frame.error.message)
      return
    }
    if (!('sessionId' in frame)) return
    const runtime = this.workspace.runtimeFor(frame.sessionId)
    if (runtime === undefined) return
    if (frame.type === 'host/session-status') runtime.setRunState(frame.running ? 'running' : 'idle')
    if (frame.type === 'host/agent-error') runtime.setError(frame.message)
  }

  private publishInteraction(event: SessionInteractionEvent): void {
    for (const listener of this.interactionListeners) listener(event)
  }
}
