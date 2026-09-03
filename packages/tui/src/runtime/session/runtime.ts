import type {
  HistoryEntry,
  ModelCatalog,
  QueuedInboxItem,
  SessionRequestId,
} from './contracts.ts'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import {
  buildExecutionSnapshot,
  ExecutionProjector,
  type RuntimeExecutionActivity,
} from '../execution/projection/index.ts'
import { AtomicSnapshotStore, type SnapshotListener } from '../dispatch/snapshot-store.ts'
import type { LifecycleScope } from '../lifecycle/scope.ts'
import type { SessionBindingState } from '../lifecycle/session-machine.ts'
import {
  SubmissionTracker,
  type PendingSubmission,
  type SubmissionActivityUpdate,
} from './submission.ts'
import type {
  ConnectionPhase,
  RuntimeSessionData,
  RuntimeSessionSnapshot,
  SessionConnectionState,
  SessionId,
  SessionRunState,
} from './snapshot.ts'
import type { SessionHistoryPage, SessionProjectionBaseline } from './history-page.ts'

export type AppendEventResult = 'appended' | 'duplicate' | 'gap' | 'retired'

function runtimeActivities(submissions: readonly PendingSubmission[]): RuntimeExecutionActivity[] {
  return submissions.flatMap((submission): RuntimeExecutionActivity[] => {
    const activity = submission.activity
    return activity?.kind === 'vision'
      ? [{ kind: 'vision', analysisId: activity.analysisId, startedAt: activity.startedAt }]
      : []
  })
}

export function emptyRuntimeSessionSnapshot(
  cwd: string,
  connection: SessionConnectionState,
  epoch: number,
  binding: SessionBindingState<SessionId> = { phase: 'unbound' },
): RuntimeSessionSnapshot {
  return {
    binding,
    sessionId: undefined,
    cwd,
    runState: 'idle',
    connection,
    events: [],
    historyHasMore: false,
    queue: [],
    pendingSubmissions: [],
    execution: buildExecutionSnapshot({
      sessionId: undefined,
      epoch,
      entries: [],
      sessionRunning: false,
      runtimeActivities: [],
    }),
    modelCatalog: undefined,
    projections: {},
    notice: undefined,
    error: undefined,
  }
}

/** Owns all mutable read-model state and asynchronous work for one Session epoch. */
export class SessionRuntime {
  private readonly projector = new ExecutionProjector()
  private readonly submissions = new SubmissionTracker()
  private readonly store: AtomicSnapshotStore<RuntimeSessionSnapshot>
  private projectionSeqs: Record<string, number> = {}
  private followCursor: number | undefined

  constructor(
    private readonly scope: LifecycleScope,
    readonly sessionId: SessionId,
    readonly epoch: number,
    cwd: string,
    connection: SessionConnectionState,
  ) {
    this.store = new AtomicSnapshotStore(this.createSnapshot({
      binding: { phase: 'active', sessionId, epoch },
      sessionId,
      cwd,
      runState: 'idle',
      connection,
      events: [],
      historyHasMore: false,
      queue: [],
      pendingSubmissions: [],
      modelCatalog: undefined,
      projections: {},
      notice: undefined,
      error: undefined,
    }))
  }

  get active(): boolean {
    return this.scope.active
  }

  get signal(): AbortSignal {
    return this.scope.signal
  }

  get historyCursor(): number | undefined {
    return this.followCursor
  }

  get current(): Readonly<RuntimeSessionSnapshot> {
    return this.store.current
  }

  /** Create an owned child for feature instances bound to this exact epoch. */
  forkScope(name: string): LifecycleScope {
    return this.scope.fork(name)
  }

  subscribe(listener: SnapshotListener<RuntimeSessionSnapshot>): () => void {
    return this.store.subscribe(listener)
  }

  dispose(): Promise<void> {
    return this.scope.dispose()
  }

  notice(message: string): void {
    this.update(data => ({ ...data, notice: message, error: undefined }))
  }

  setError(message: string | undefined): void {
    this.update(data => ({ ...data, error: message }))
  }

  setConnection(
    channel: keyof SessionConnectionState,
    phase: ConnectionPhase,
    error: string | undefined = this.current.error,
  ): void {
    this.update(data => ({
      ...data,
      connection: { ...data.connection, [channel]: phase },
      error,
    }))
  }

  setBinding(binding: SessionBindingState<SessionId>): void {
    this.update(data => ({ ...data, binding }))
  }

  setRunState(runState: SessionRunState): void {
    this.update(data => ({ ...data, runState }))
  }

  setModelCatalog(modelCatalog: ModelCatalog): void {
    this.update(data => ({ ...data, modelCatalog }))
  }

  setQueue(queue: readonly QueuedInboxItem[]): void {
    this.update(data => ({ ...data, queue: [...queue], pendingSubmissions: this.submissions.snapshot }))
  }

  startSubmission(text: string, mode: 'queue' | 'steer'): PendingSubmission | undefined {
    if (!this.active) return undefined
    const pending = this.submissions.start(text, mode, this.current.runState !== 'idle')
    this.publishSubmissions(data => ({ ...data, notice: undefined, error: undefined }))
    return pending
  }

  setSubmissionActivity(key: number, activity: SubmissionActivityUpdate): void {
    if (!this.active) return
    this.submissions.setActivity(key, activity)
    this.publishSubmissions()
  }

  acceptSubmission(key: number, requestId: SessionRequestId): void {
    if (!this.active) return
    this.submissions.accept(key, requestId)
    this.publishSubmissions()
  }

  rejectSubmission(key: number): void {
    if (!this.active) return
    this.submissions.reject(key)
    this.publishSubmissions()
  }

  settleSubmission(key: number): void {
    if (!this.active) return
    this.submissions.settle(key)
    this.publishSubmissions()
  }

  hydrate(page: SessionHistoryPage, cursor: number): void {
    if (!this.active) return
    this.followCursor = cursor
    this.submissions.observeEvents(page.events)
    this.update(data => ({
      ...data,
      events: [...page.events],
      historyHasMore: page.hasMore,
      pendingSubmissions: this.submissions.snapshot,
      projections: page.projections === undefined
        ? data.projections
        : this.mergeProjectionBaseline(data.projections, page.projections),
      error: undefined,
    }))
  }

  prependHistory(page: SessionHistoryPage): boolean {
    if (!this.active) return false
    const present = new Set(this.current.events.map(entry => entry.event.seq))
    const earlier = page.events.filter(entry => !present.has(entry.event.seq))
    this.update(data => ({
      ...data,
      events: [...earlier, ...data.events],
      historyHasMore: page.hasMore,
      error: undefined,
    }))
    return earlier.length > 0
  }

  appendEvent(entry: HistoryEntry): AppendEventResult {
    if (!this.active) return 'retired'
    this.submissions.observeEvents([entry])
    const currentLast = this.current.events.at(-1)?.event.seq
    if (currentLast !== undefined && entry.event.seq <= currentLast) {
      this.publishSubmissions()
      return 'duplicate'
    }
    if (currentLast !== undefined && entry.event.seq !== currentLast + 1) return 'gap'
    this.update(data => ({
      ...data,
      events: [...data.events, entry],
      pendingSubmissions: this.submissions.snapshot,
      error: undefined,
    }))
    return 'appended'
  }

  applyProjection(key: string, value: unknown, seq: number): void {
    if (!this.active || (this.projectionSeqs[key] ?? -1) >= seq) return
    this.projectionSeqs[key] = seq
    this.update(data => ({
      ...data,
      projections: { ...data.projections, [key]: value },
    }))
  }

  applyProjectionBaseline(baseline: SessionProjectionBaseline): void {
    if (!this.active) return
    this.update(data => ({
      ...data,
      projections: this.mergeProjectionBaseline(data.projections, baseline),
    }))
  }

  private mergeProjectionBaseline(
    current: Readonly<Partial<SessionProjectionMap>>,
    baseline: SessionProjectionBaseline,
  ): Partial<SessionProjectionMap> {
    const values = { ...current } as Record<string, unknown>
    const source = baseline.values as Record<string, unknown>
    const keys = new Set([...Object.keys(values), ...Object.keys(source)])
    for (const key of keys) {
      if ((this.projectionSeqs[key] ?? -1) > baseline.asOfSeq) continue
      if (Object.hasOwn(source, key)) values[key] = source[key]
      else delete values[key]
      this.projectionSeqs[key] = baseline.asOfSeq
    }
    return values as Partial<SessionProjectionMap>
  }

  private publishSubmissions(
    transform: (data: RuntimeSessionData) => RuntimeSessionData = data => data,
  ): void {
    this.update(data => transform({ ...data, pendingSubmissions: this.submissions.snapshot }))
  }

  private update(update: (current: RuntimeSessionData) => RuntimeSessionData): boolean {
    if (!this.active) return false
    const current = this.dataOf(this.store.current)
    return this.store.replace(this.createSnapshot(update(current)))
  }

  private createSnapshot(data: RuntimeSessionData): RuntimeSessionSnapshot {
    return {
      ...data,
      execution: this.projector.project({
        sessionId: String(this.sessionId),
        epoch: this.epoch,
        entries: data.events,
        sessionRunning: data.runState !== 'idle',
        runtimeActivities: runtimeActivities(data.pendingSubmissions),
      }),
    }
  }

  private dataOf(snapshot: Readonly<RuntimeSessionSnapshot>): RuntimeSessionData {
    const { execution: _execution, ...data } = snapshot
    return data
  }
}
