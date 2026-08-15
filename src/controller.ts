import type {
  ClientResponse,
  HistoryEntry,
  HostFrame,
  IApiClient,
  ModelSelection,
  MuxFrame,
  QueuedInboxItem,
  RpcId,
  RpcRequest,
  SessionModels,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
// Merge the Web composer's projection keys into SessionProjectionMap.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { RewindPreview } from './checkpoint.ts'

type SessionId = SessionSummary['sessionId']

/** Answerable approval request delivered by the mux stream. */
export type ApprovalPrompt = Extract<MuxFrame, { type: 'approval/requested' }> & { rpcId: RpcId }

/** Answerable question batch delivered by the mux stream. */
export type QuestionPrompt = Extract<MuxFrame, { type: 'question/requested' }> & { rpcId: RpcId }

/** Renderer-facing state for the one active terminal session. */
export interface TuiState {
  sessionId: SessionId | undefined
  cwd: string
  running: boolean
  connected: boolean
  events: HistoryEntry[]
  queue: QueuedInboxItem[]
  models: SessionModels | undefined
  projections: Partial<SessionProjectionMap>
  notice: string | undefined
  error: string | undefined
}

/** UI callbacks kept independent from the concrete pi-tui renderer. */
export interface TuiControllerSink {
  render(state: Readonly<TuiState>): void
  requestApproval(prompt: ApprovalPrompt): void
  requestQuestions(prompt: QuestionPrompt): void
}

interface RpcResultLike<T> {
  result: { ok: true; value: T } | { ok: false; error: { message: string } }
}

function valueOf<T>(response: RpcResultLike<T>): T {
  if (response.result.ok) return response.result.value
  throw new Error(response.result.error.message)
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
export class HarnessController {
  private readonly abort = new AbortController()
  private state: TuiState
  private resyncTask: Promise<void> | undefined
  private generation = 0
  private projectionSeqs: Record<string, number> = {}

  constructor(
    private readonly api: IApiClient,
    private readonly sink: TuiControllerSink,
    cwd: string,
    private readonly historyMessages: number,
  ) {
    this.state = {
      sessionId: undefined,
      cwd,
      running: false,
      connected: false,
      events: [],
      queue: [],
      models: undefined,
      projections: {},
      notice: undefined,
      error: undefined,
    }
  }

  /** Current immutable-by-convention state snapshot. */
  get current(): Readonly<TuiState> {
    return this.state
  }

  /** Create or resume the initial session, then attach both event streams. */
  async start(resumeSessionId?: string): Promise<void> {
    await this.openSession(resumeSessionId)
    void this.runMuxLoop()
    void this.runHostLoop()
  }

  /** Stop stream reads and reject further controller work. */
  dispose(): void {
    this.abort.abort()
  }

  /** Publish a transient terminal-only notice. */
  notice(message: string): void {
    this.patch({ notice: message, error: undefined })
  }

  /** List resumable session rows for a terminal selector. */
  async sessions(): Promise<SessionSummary[]> {
    return valueOf(await this.api.sessions.list({})).items
  }

  /** Switch the terminal to a fresh session in the current working directory. */
  async newSession(): Promise<void> {
    await this.openSession()
  }

  /** Switch the terminal to an existing persisted or live session. */
  async resume(sessionId: string): Promise<void> {
    await this.openSession(sessionId)
  }

  /** Fork to the boundary before the checkpointed turn, or create a fresh first-turn replacement. */
  async rewind(preview: RewindPreview): Promise<void> {
    const source = this.requireSession()
    if (String(source) !== preview.sessionId) throw new Error('the active session changed before rewind')
    let target: SessionId
    if (preview.previousTurnEndSeq === undefined) {
      const created = valueOf(await this.api.sessions.create({ cwd: this.state.cwd }))
      target = created.sessionId
      const selection = this.state.models?.current
      if (selection !== undefined) {
        valueOf(await this.api.sessions.selectModel({
          sessionId: target,
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        }))
      }
    } else {
      target = valueOf(await this.api.sessions.fork({
        sessionId: source,
        atSeq: preview.previousTurnEndSeq,
      })).sessionId
    }
    await this.openSession(String(target))
  }

  /** Submit ordinary text using the caller-selected queue placement. */
  async prompt(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const sessionId = this.requireSession()
    const clientTimeZone = terminalTimeZone()
    const response = await this.api.sessions.prompt({
      sessionId,
      mode,
      content: [{ type: 'text', text }],
      ...clientTimeZone === undefined ? {} : { clientTimeZone },
    })
    const accepted = valueOf(response)
    if (accepted.command?.text !== undefined) this.notice(accepted.command.text)
  }

  /** Cancel the active turn while preserving pending queued work. */
  async cancel(): Promise<void> {
    valueOf(await this.api.sessions.cancel({ sessionId: this.requireSession() }))
  }

  /** Refresh the model directory used by the selector and status line. */
  async refreshModels(): Promise<SessionModels> {
    const models = valueOf(await this.api.sessions.models({ sessionId: this.requireSession() }))
    this.patch({ models })
    return models
  }

  /** Select an exact model route for subsequent steps. */
  async selectModel(selection: ModelSelection): Promise<void> {
    const selected = valueOf(await this.api.sessions.selectModel({
      sessionId: this.requireSession(),
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    })).selected
    const models = this.state.models
    this.patch({ models: models === undefined ? undefined : { ...models, current: selected } })
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

  /** Cancel a question batch without manufacturing an answer. */
  async cancelQuestions(prompt: QuestionPrompt): Promise<void> {
    const response: ClientResponse = {
      type: 'client-response',
      rpcId: prompt.rpcId,
      result: {
        ok: false,
        error: { code: 'cancelled', message: 'the user cancelled the question', details: {} },
      },
    }
    const receipt = await this.api.respond(response)
    if (!receipt.accepted) throw new Error(`question cancellation was ${receipt.reason}`)
  }

  private async respond(rpcId: RpcId, value: unknown): Promise<void> {
    const response: ClientResponse = {
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    }
    const receipt = await this.api.respond(response)
    if (!receipt.accepted) throw new Error(`interaction response was ${receipt.reason}`)
  }

  private requireSession(): SessionId {
    const sessionId = this.state.sessionId
    if (sessionId === undefined) throw new Error('no terminal session is active')
    return sessionId
  }

  private async openSession(resumeSessionId?: string): Promise<void> {
    const generation = ++this.generation
    const host = valueOf(await this.api.host.describe({}))
    let cwd = this.state.cwd || host.cwd
    let requested: SessionId | undefined
    if (resumeSessionId !== undefined) {
      const summary = valueOf(await this.api.sessions.list({})).items
        .find(item => String(item.sessionId) === resumeSessionId)
      if (summary === undefined) throw new Error(`session "${resumeSessionId}" was not found`)
      requested = summary.sessionId
      cwd = summary.cwd ?? host.cwd
    }
    const created = valueOf(await this.api.sessions.create({
      cwd,
      ...requested === undefined ? {} : { sessionId: requested },
    }))
    if (generation !== this.generation) return
    this.state = {
      sessionId: created.sessionId,
      cwd,
      running: false,
      connected: this.state.connected,
      events: [],
      queue: [],
      models: undefined,
      projections: {},
      notice: undefined,
      error: undefined,
    }
    this.emit()
    this.projectionSeqs = {}
    await Promise.all([this.resync(), this.refreshModels().catch(() => undefined)])
  }

  private async resync(): Promise<void> {
    if (this.resyncTask !== undefined) return this.resyncTask
    const sessionId = this.requireSession()
    const generation = this.generation
    this.resyncTask = (async () => {
      const page = valueOf(await this.api.sessions.history({
        sessionId,
        maxMessages: this.historyMessages,
      }))
      if (generation !== this.generation || sessionId !== this.state.sessionId) return
      const projections = page.projections === undefined
        ? this.state.projections
        : this.mergeProjectionBaseline(page.projections.asOfSeq, page.projections.values)
      this.patch({ events: page.events, projections, error: undefined })
    })().finally(() => {
      this.resyncTask = undefined
    })
    return this.resyncTask
  }

  private async runMuxLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        for await (const request of this.api.events.mux({}, this.abort.signal)) {
          await this.handleMux(request)
        }
      } catch (error: unknown) {
        if (this.abort.signal.aborted) return
        this.patch({ connected: false, error: `event stream disconnected: ${String(error)}` })
      }
      if (this.abort.signal.aborted) return
      await abortableDelay(500, this.abort.signal)
      await this.resync().catch(() => undefined)
    }
  }

  private async runHostLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        for await (const request of this.api.events.host({}, this.abort.signal)) {
          this.handleHost(request.payload)
        }
      } catch (error: unknown) {
        if (this.abort.signal.aborted) return
        this.patch({ error: `host stream disconnected: ${String(error)}` })
      }
      if (this.abort.signal.aborted) return
      await abortableDelay(500, this.abort.signal)
    }
  }

  private async handleMux(request: RpcRequest<MuxFrame>): Promise<void> {
    const frame = request.payload
    if (frame.type === 'stream/error') {
      this.patch({ error: frame.error.message })
      return
    }
    if (frame.type === 'approval/requested') {
      this.sink.requestApproval({ ...frame, rpcId: request.rpcId })
      return
    }
    if (frame.type === 'question/requested') {
      this.sink.requestQuestions({ ...frame, rpcId: request.rpcId })
      return
    }
    if (frame.sessionId !== this.state.sessionId) return
    this.patch({ connected: true })
    switch (frame.type) {
      case 'session/event':
        await this.appendEvent({ event: frame.event, ...frame.view === undefined ? {} : { view: frame.view } })
        return
      case 'session/subscribed': {
        const last = this.state.events.at(-1)?.event.seq ?? -1
        if (frame.lastSeq !== last) await this.resync()
        return
      }
      case 'session/queue':
        this.patch({ queue: frame.items })
        return
      case 'session/projection':
        this.applyProjection(frame.key, frame.value, frame.seq)
        return
      case 'session/jobs':
      case 'approval/resolved':
      case 'question/resolved':
        return
    }
  }

  private handleHost(frame: HostFrame): void {
    if (frame.type === 'stream/error') {
      this.patch({ error: frame.error.message })
      return
    }
    if (!('sessionId' in frame) || frame.sessionId !== this.state.sessionId) return
    if (frame.type === 'host/session-status') this.patch({ running: frame.running, connected: true })
    if (frame.type === 'host/agent-error') this.patch({ error: frame.message })
  }

  private async appendEvent(entry: HistoryEntry): Promise<void> {
    const currentLast = this.state.events.at(-1)?.event.seq
    if (currentLast !== undefined && entry.event.seq <= currentLast) return
    if (currentLast !== undefined && entry.event.seq !== currentLast + 1) {
      await this.resync()
      return
    }
    this.patch({ events: [...this.state.events, entry], error: undefined })
  }

  private mergeProjectionBaseline(
    asOfSeq: number,
    baseline: Partial<SessionProjectionMap>,
  ): Partial<SessionProjectionMap> {
    const values = { ...this.state.projections } as Record<string, unknown>
    const keys = new Set([...Object.keys(values), ...Object.keys(baseline)])
    for (const key of keys) {
      if ((this.projectionSeqs[key] ?? -1) > asOfSeq) continue
      if (Object.hasOwn(baseline, key)) values[key] = (baseline as Record<string, unknown>)[key]
      else delete values[key]
      this.projectionSeqs[key] = asOfSeq
    }
    return values as Partial<SessionProjectionMap>
  }

  private applyProjection(key: string, value: unknown, seq: number): void {
    if ((this.projectionSeqs[key] ?? -1) >= seq) return
    this.projectionSeqs[key] = seq
    this.patch({
      projections: {
        ...this.state.projections,
        [key]: value,
      },
    })
  }

  private patch(change: Partial<TuiState>): void {
    this.state = { ...this.state, ...change }
    this.emit()
  }

  private emit(): void {
    this.sink.render(this.state)
  }
}
