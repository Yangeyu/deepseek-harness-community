import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessModelPort } from '../../../src/infrastructure/harness/models.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import type {
  HistoryEntry,
  ModelCatalog,
  ModelSelection,
  SessionId,
  SessionRequestId,
  SessionSummary,
} from '../../../src/runtime/session/contracts.ts'
import type { SessionHistoryPage, SessionProjectionBaseline } from '../../../src/runtime/session/history-page.ts'
import type {
  ApprovalPrompt,
  QuestionPrompt,
  SessionInteractionHandler,
  SessionInteractionSource,
} from '../../../src/runtime/session/interactions.ts'
import { SessionManager } from '../../../src/runtime/session/manager.ts'
import { selectedModel } from '../../../src/runtime/session/model-selection.ts'
import type {
  SessionControlFrame,
  SessionFollowFrame,
  SessionPromptReceipt,
  SessionTransport,
} from '../../../src/runtime/session/transport.ts'

function sessionId(value: string): SessionId {
  return value as SessionId
}

function baseline(
  asOfSeq = 0,
  values: SessionProjectionBaseline['values'] = {},
): SessionProjectionBaseline {
  return { asOfSeq, values }
}

function userMessage(seq: number, id: SessionRequestId, text: string): HistoryEntry {
  return {
    event: {
      type: 'user/message',
      seq,
      time: seq,
      surfaceOp: 'append',
      data: {
        id: `message-${String(id)}`,
        role: 'user',
        source: { kind: 'user', rpcId: id },
        content: [{ type: 'text', text }],
      },
    },
  } as unknown as HistoryEntry
}

function turnStart(seq: number): HistoryEntry {
  return {
    event: { type: 'turn/start', seq, time: seq, data: { turn: seq } },
  } as unknown as HistoryEntry
}

class FrameQueue<Frame> {
  private readonly frames: Frame[] = []
  private waiter: ((frame: Frame | undefined) => void) | undefined

  push(frame: Frame): void {
    const waiter = this.waiter
    if (waiter === undefined) {
      this.frames.push(frame)
      return
    }
    this.waiter = undefined
    waiter(frame)
  }

  async *read(signal: AbortSignal): AsyncGenerator<Frame> {
    while (!signal.aborted) {
      const frame = this.frames.shift() ?? await new Promise<Frame | undefined>((resolve) => {
        let settle!: (value: Frame | undefined) => void
        const onAbort = (): void => {
          if (this.waiter === settle) this.waiter = undefined
          resolve(undefined)
        }
        settle = (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        }
        this.waiter = settle
        signal.addEventListener('abort', onAbort, { once: true })
      })
      if (frame === undefined) return
      yield frame
    }
  }
}

class FakeInteractionSource implements SessionInteractionSource {
  handler: SessionInteractionHandler | undefined

  connect(handler: SessionInteractionHandler): () => void {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = undefined
    }
  }
}

class FakeSessionTransport implements SessionTransport {
  readonly followFrames = new Map<string, FrameQueue<SessionFollowFrame>>()
  readonly controlFrames = new FrameQueue<SessionControlFrame>()
  readonly histories = new Map<string, SessionHistoryPage>()
  readonly projections = new Map<string, SessionProjectionBaseline>()
  readonly promptRequests: Parameters<SessionTransport['prompt']>[0][] = []
  readonly selectionRequests: Array<{ sessionId: SessionId; selection: ModelSelection }> = []
  readonly createRequests: Parameters<SessionTransport['createSession']>[0][] = []
  readonly forkRequests: Parameters<SessionTransport['forkSession']>[0][] = []
  readonly pageRequests: Parameters<SessionTransport['page']>[0][] = []
  readonly cancelRequests: SessionId[] = []
  readonly summaries: SessionSummary[] = []
  readonly statusListeners = new Set<(sessionId: SessionId, running: boolean) => void>()
  readonly errorListeners = new Set<(sessionId: SessionId, message: string) => void>()
  promptImplementation: SessionTransport['prompt'] | undefined
  pageResult: SessionHistoryPage = { events: [], hasMore: false }
  controlBaseline: Extract<SessionControlFrame, { type: 'baseline' }> = {
    type: 'baseline', queues: {}, projections: {},
  }
  modelCatalogValue: ModelCatalog = {
    default: { provider: 'default-provider', model: 'default-model' },
    routableProviders: ['default-provider', 'selected-provider'],
    groups: [],
    failures: [],
  }
  private created = 0

  describeHost(): Promise<{ readonly cwd: string }> {
    return Promise.resolve({ cwd: '/host-workspace' })
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    return Promise.resolve(this.summaries)
  }

  createSession(request: Parameters<SessionTransport['createSession']>[0]): Promise<{ readonly sessionId: SessionId }> {
    this.createRequests.push(request)
    return Promise.resolve({ sessionId: request.sessionId ?? sessionId(`session-${String(++this.created)}`) })
  }

  forkSession(request: Parameters<SessionTransport['forkSession']>[0]): Promise<{ readonly sessionId: SessionId }> {
    this.forkRequests.push(request)
    const forked = sessionId('session-forked')
    this.summaries.push({ sessionId: forked, updatedAt: Date.now(), running: false, blank: false, cwd: '/workspace' })
    return Promise.resolve({ sessionId: forked })
  }

  page(
    request: Parameters<SessionTransport['page']>[0],
    _signal: AbortSignal,
  ): Promise<SessionHistoryPage> {
    this.pageRequests.push(request)
    return Promise.resolve(this.pageResult)
  }

  modelCatalog(): Promise<ModelCatalog> {
    return Promise.resolve(this.modelCatalogValue)
  }

  selectModel(target: SessionId, selection: ModelSelection): Promise<void> {
    this.selectionRequests.push({ sessionId: target, selection })
    return Promise.resolve()
  }

  prompt(
    request: Parameters<SessionTransport['prompt']>[0],
    signal: AbortSignal,
  ): Promise<SessionPromptReceipt> {
    this.promptRequests.push(request)
    return this.promptImplementation?.(request, signal) ?? Promise.resolve({ requestId: request.requestId })
  }

  cancel(target: SessionId): Promise<void> {
    this.cancelRequests.push(target)
    return Promise.resolve()
  }

  openPath(): Promise<void> {
    return Promise.resolve()
  }

  async *follow(
    target: SessionId,
    _maxMessages: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionFollowFrame> {
    const key = String(target)
    const page = this.histories.get(key) ?? { events: [], hasMore: false }
    const projection = this.projections.get(key) ?? baseline()
    yield {
      type: 'snapshot',
      cursor: Number(page.events.at(-1)?.event.seq ?? projection.asOfSeq),
      page: { ...page, projections: projection },
    }
    yield* this.followQueue(target).read(signal)
  }

  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    yield this.controlBaseline
    yield* this.controlFrames.read(signal)
  }

  onStatus(listener: (sessionId: SessionId, running: boolean) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  onError(listener: (sessionId: SessionId, message: string) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  followQueue(target: SessionId): FrameQueue<SessionFollowFrame> {
    const key = String(target)
    const existing = this.followFrames.get(key)
    if (existing !== undefined) return existing
    const queue = new FrameQueue<SessionFollowFrame>()
    this.followFrames.set(key, queue)
    return queue
  }

  publishStatus(target: SessionId, running: boolean): void {
    for (const listener of this.statusListeners) listener(target, running)
  }
}

const managers = new Set<SessionManager>()

async function startFixture(transport = new FakeSessionTransport()) {
  const scope = new LifecycleScope('manager-test')
  const interactions = new FakeInteractionSource()
  const manager = new SessionManager(scope, transport, interactions, '/workspace', 200)
  managers.add(manager)
  await manager.start()
  await vi.waitFor(() => { expect(manager.current.connection.control).toBe('online') })
  return { manager, transport, interactions }
}

afterEach(async () => {
  await Promise.all([...managers].map(manager => manager.dispose()))
  managers.clear()
})

describe('SessionManager', () => {
  it('hydrates one Session epoch from the follow snapshot and durable projections', async () => {
    const transport = new FakeSessionTransport()
    const selected = { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high' }
    transport.projections.set('session-1', baseline(3, {
      modelSelection: { lastUsed: null, next: selected },
    }))
    transport.histories.set('session-1', { events: [turnStart(3)], hasMore: true })

    const { manager } = await startFixture(transport)

    expect(manager.current).toMatchObject({
      sessionId: sessionId('session-1'),
      historyHasMore: true,
      connection: { events: 'online', control: 'online' },
      modelCatalog: transport.modelCatalogValue,
    })
    expect(selectedModel(manager.current.modelCatalog, manager.current.projections)).toEqual(selected)
  })

  it('changes the effective model only after the Session projection advances', async () => {
    const { manager, transport } = await startFixture()
    const models = new HarnessModelPort(transport, manager)
    const selected = { provider: 'selected-provider', model: 'selected-model' }

    await models.select(selected)

    expect(transport.selectionRequests).toEqual([{
      sessionId: sessionId('session-1'), selection: selected,
    }])
    expect(selectedModel(manager.current.modelCatalog, manager.current.projections))
      .toEqual(transport.modelCatalogValue.default)

    transport.controlFrames.push({
      type: 'projection',
      sessionId: sessionId('session-1'),
      key: 'modelSelection',
      value: { lastUsed: null, next: selected },
      seq: 1,
    })
    await vi.waitFor(() => {
      expect(selectedModel(manager.current.modelCatalog, manager.current.projections)).toEqual(selected)
    })
  })

  it('reconciles a durable prompt that arrives before its command receipt', async () => {
    const { manager, transport } = await startFixture()
    const receipt = Promise.withResolvers<SessionPromptReceipt>()
    transport.promptImplementation = async () => receipt.promise

    const submitted = manager.prompt('race', 'queue')
    await vi.waitFor(() => { expect(transport.promptRequests).toHaveLength(1) })
    const id = transport.promptRequests[0]!.requestId
    transport.followQueue(sessionId('session-1')).push({ type: 'event', entry: userMessage(1, id, 'race') })
    await vi.waitFor(() => { expect(manager.current.events).toHaveLength(1) })
    expect(manager.current.pendingSubmissions).toHaveLength(1)

    receipt.resolve({ requestId: id })
    await submitted

    expect(manager.current.pendingSubmissions).toEqual([])
  })

  it('prevents a late command receipt from mutating the replacement Session epoch', async () => {
    const { manager, transport } = await startFixture()
    const receipt = Promise.withResolvers<SessionPromptReceipt>()
    transport.promptImplementation = async () => receipt.promise
    const submitted = manager.prompt('old epoch', 'queue')
    await vi.waitFor(() => { expect(transport.promptRequests).toHaveLength(1) })

    await manager.newSession()
    expect(String(manager.current.sessionId)).toBe('session-2')
    receipt.resolve({ requestId: transport.promptRequests[0]!.requestId })
    await submitted

    expect(manager.current.pendingSubmissions).toEqual([])
    expect(manager.current.events).toEqual([])
  })

  it('shares an in-flight history page and advances its cursor only after settlement', async () => {
    const transport = new FakeSessionTransport()
    transport.histories.set('session-1', { events: [turnStart(5)], hasMore: true })
    const pending = Promise.withResolvers<SessionHistoryPage>()
    vi.spyOn(transport, 'page').mockImplementationOnce(request => {
      transport.pageRequests.push(request)
      return pending.promise
    })
    const { manager } = await startFixture(transport)
    const first = manager.loadEarlierHistory()
    const shared = manager.loadEarlierHistory()
    expect(transport.pageRequests).toHaveLength(1)
    pending.resolve({ events: [turnStart(1)], hasMore: true })
    await expect(Promise.all([first, shared])).resolves.toEqual([true, true])
    transport.pageResult = { events: [turnStart(0)], hasMore: false }
    await expect(manager.loadEarlierHistory()).resolves.toBe(true)

    expect(transport.pageRequests).toEqual([
      { sessionId: sessionId('session-1'), throughSeq: 5, beforeSeq: 5, maxMessages: 200 },
      { sessionId: sessionId('session-1'), throughSeq: 5, beforeSeq: 1, maxMessages: 200 },
    ])
    expect(manager.current.events.map(entry => entry.event.seq)).toEqual([0, 1, 5])
    expect(manager.current.historyHasMore).toBe(false)
  })

  it('owns Host approval requests only while their Session epoch is visible', async () => {
    const { manager, interactions } = await startFixture()
    const events: string[] = []
    manager.onInteraction((event) => { events.push(event.type) })
    const prompt: ApprovalPrompt = {
      requestId: 'approval-1',
      sessionId: sessionId('session-1'),
      toolName: 'bash',
    }

    const answer = interactions.handler!.approval(prompt)
    await vi.waitFor(() => { expect(events).toEqual(['approval']) })
    await manager.answerApproval(prompt, 'allowed-once')

    await expect(answer).resolves.toBe('allowed-once')
    expect(events).toEqual(['approval', 'resolved'])
    await expect(interactions.handler!.approval({
      ...prompt, requestId: 'foreign', sessionId: sessionId('foreign'),
    })).resolves.toBeUndefined()
  })

  it('withdraws an aborted question request through the same interaction lifecycle', async () => {
    const { manager, interactions } = await startFixture()
    const controller = new AbortController()
    const events: string[] = []
    manager.onInteraction((event) => {
      events.push(event.type === 'resolved' ? event.resolution.outcome : event.type)
    })
    const prompt: QuestionPrompt = {
      requestId: 'questions-1',
      sessionId: sessionId('session-1'),
      questions: [{ id: 'language', question: 'Language?', options: [{ label: 'TypeScript' }] }],
      signal: controller.signal,
    }

    const answer = interactions.handler!.questions(prompt)
    controller.abort(new Error('withdrawn'))

    await expect(answer).rejects.toThrow('withdrawn')
    expect(events).toEqual(['questions', 'cancelled'])
  })

  it('forks at a durable boundary without replaying terminal state', async () => {
    const { manager, transport } = await startFixture()
    const phases: string[] = []

    await expect(manager.rewind({
      sessionId: 'session-1', previousTurnEndSeq: 9,
    }, phase => { phases.push(phase) })).resolves.toBe(sessionId('session-forked'))

    expect(transport.forkRequests).toEqual([{ sessionId: sessionId('session-1'), atSeq: 9 }])
    expect(phases).toEqual(['forking', 'opening'])
    expect(manager.current.sessionId).toBe(sessionId('session-forked'))
  })

  it('routes Host status only to the matching active Session', async () => {
    const { manager, transport } = await startFixture()

    transport.publishStatus(sessionId('foreign'), true)
    expect(manager.current.runState).toBe('idle')
    transport.publishStatus(sessionId('session-1'), true)
    expect(manager.current.runState).toBe('running')
    await manager.cancel()

    expect(manager.current.runState).toBe('interrupting')
    expect(transport.cancelRequests).toEqual([sessionId('session-1')])
  })

})
