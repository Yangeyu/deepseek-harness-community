import type {
  HistoryEntry,
  SessionRequestId,
} from './contracts.ts'

export interface PendingVisionActivity {
  kind: 'vision'
  analysisId: string
  imageCount: number
  startedAt: number
}

export type PendingSubmissionActivity = PendingVisionActivity
export type SubmissionActivityUpdate = Omit<PendingVisionActivity, 'startedAt'>

/** Local prompt echo retained until the Host inbox or conversation represents it. */
export interface PendingSubmission {
  key: number
  text: string
  mode: 'queue' | 'steer'
  intent: 'working' | 'queueing' | 'steering'
  requestId?: SessionRequestId
  activity?: PendingSubmissionActivity
}

function userMessageRequestIds(entry: HistoryEntry): SessionRequestId[] {
  const event = entry.event
  const messages = event.type === 'user/message' ? [event.data]
    : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
  return messages.flatMap(({ source }) =>
    source.kind === 'user' && 'rpcId' in source ? [source.rpcId] : [])
}

/** Reconciles optimistic prompts with the authoritative inbox and conversation. */
export class SubmissionTracker {
  private nextKey = 0
  private pending: PendingSubmission[] = []
  private readonly observedRequestIds = new Set<SessionRequestId>()

  /** Return an immutable-by-convention state snapshot for the renderer. */
  get snapshot(): PendingSubmission[] {
    return [...this.pending]
  }

  /** Publish a prompt before its Host request settles. */
  start(text: string, mode: PendingSubmission['mode'], running: boolean): PendingSubmission {
    const intent = mode === 'steer' ? 'steering' : running ? 'queueing' : 'working'
    const submission = { key: ++this.nextKey, text, mode, intent } as const
    this.pending = [...this.pending, submission]
    return submission
  }

  /** Attach a preparation phase without changing prompt reconciliation identity. */
  setActivity(key: number, activity: SubmissionActivityUpdate): void {
    this.pending = this.pending.map(item => item.key === key
      ? { ...item, activity: { ...activity, startedAt: Date.now() } }
      : item)
  }

  /** Attach the request identity or retire an already durable prompt. */
  accept(key: number, requestId: SessionRequestId): void {
    this.pending = this.pending.flatMap((item): PendingSubmission[] => {
      if (item.key !== key) return [item]
      return this.observedRequestIds.has(requestId) ? [] : [{ ...item, requestId }]
    })
    this.pruneObservedRequestIds()
  }

  /** Remove a prompt whose Host request failed. */
  reject(key: number): void {
    this.settle(key)
  }

  /** Retire input settled without a durable user-message event, such as a command. */
  settle(key: number): void {
    this.pending = this.pending.filter(item => item.key !== key)
    this.pruneObservedRequestIds()
  }

  /** Retire local echoes when durable inbox admission or conversation events arrive. */
  observeEvents(entries: readonly HistoryEntry[]): void {
    for (const entry of entries) {
      for (const requestId of userMessageRequestIds(entry)) this.observe(requestId)
    }
    this.reconcile()
  }

  /** Drop terminal-local state when switching sessions. */
  reset(): void {
    this.pending = []
    this.observedRequestIds.clear()
  }

  private observe(requestId: SessionRequestId | undefined): void {
    if (requestId === undefined) return
    if (this.pending.some(item => item.requestId === undefined || item.requestId === requestId)) {
      this.observedRequestIds.add(requestId)
    }
  }

  private reconcile(): void {
    this.pending = this.pending.filter(item =>
      item.requestId === undefined || !this.observedRequestIds.has(item.requestId))
    this.pruneObservedRequestIds()
  }

  private pruneObservedRequestIds(): void {
    if (this.pending.some(item => item.requestId === undefined)) return
    const active = new Set(this.pending.flatMap(item => item.requestId === undefined ? [] : [item.requestId]))
    for (const requestId of this.observedRequestIds) {
      if (!active.has(requestId)) this.observedRequestIds.delete(requestId)
    }
  }
}
