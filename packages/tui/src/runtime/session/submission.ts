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

/** Locally visible prompt retained until its durable user-message event is observed. */
export interface PendingSubmission {
  key: number
  text: string
  mode: 'queue' | 'steer'
  intent: 'working' | 'queueing' | 'steering'
  requestId?: SessionRequestId
  durablePromptObserved?: boolean
  activity?: PendingSubmissionActivity
}

function userMessageRequestId(entry: HistoryEntry): SessionRequestId | undefined {
  const event = entry.event
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  return 'rpcId' in event.data.source ? event.data.source.rpcId : undefined
}

function visionAnalysisId(entry: HistoryEntry): string | undefined {
  const event = entry.event
  return event.type === 'user/message' && event.data.source.kind === 'community-vision'
    ? event.data.source.analysisId
    : undefined
}

/** Reconciles optimistic prompts with durable user-message events. */
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
    const durablePromptObserved = this.observedRequestIds.has(requestId)
    this.pending = this.pending.flatMap((item): PendingSubmission[] => {
      if (item.key !== key) return [item]
      if (!durablePromptObserved) return [{ ...item, requestId }]
      return item.activity === undefined ? [] : [{ ...item, requestId, durablePromptObserved: true }]
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

  /** Reconcile prompts represented by durable user-message events. */
  observeEvents(entries: readonly HistoryEntry[]): void {
    for (const entry of entries) {
      this.observe(userMessageRequestId(entry))
      const analysisId = visionAnalysisId(entry)
      if (analysisId !== undefined) {
        this.pending = this.pending.filter(item =>
          item.activity?.kind !== 'vision' || item.activity.analysisId !== analysisId)
      }
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
    this.pending = this.pending.flatMap((item): PendingSubmission[] => {
      if (item.requestId === undefined || !this.observedRequestIds.has(item.requestId)) return [item]
      return item.activity === undefined ? [] : [{ ...item, durablePromptObserved: true }]
    })
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
