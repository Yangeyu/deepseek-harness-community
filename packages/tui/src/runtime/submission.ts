import type {
  HistoryEntry,
  RpcId,
} from '@deepseek-ai/dsh-host-apiproxy'

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
  rpcId?: RpcId
  durablePromptObserved?: boolean
  activity?: PendingSubmissionActivity
}

function userMessageRpcId(entry: HistoryEntry): RpcId | undefined {
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
  private readonly observedRpcIds = new Set<RpcId>()

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

  /** Attach the echoed RPC identity or retire an already durable prompt. */
  accept(key: number, rpcId: RpcId): void {
    const durablePromptObserved = this.observedRpcIds.has(rpcId)
    this.pending = this.pending.flatMap((item): PendingSubmission[] => {
      if (item.key !== key) return [item]
      if (!durablePromptObserved) return [{ ...item, rpcId }]
      return item.activity === undefined ? [] : [{ ...item, rpcId, durablePromptObserved: true }]
    })
    this.pruneObservedRpcIds()
  }

  /** Remove a prompt whose Host request failed. */
  reject(key: number): void {
    this.settle(key)
  }

  /** Retire input settled without a durable user-message event, such as a command. */
  settle(key: number): void {
    this.pending = this.pending.filter(item => item.key !== key)
    this.pruneObservedRpcIds()
  }

  /** Reconcile prompts represented by durable user-message events. */
  observeEvents(entries: readonly HistoryEntry[]): void {
    for (const entry of entries) {
      this.observe(userMessageRpcId(entry))
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
    this.observedRpcIds.clear()
  }

  private observe(rpcId: RpcId | undefined): void {
    if (rpcId === undefined) return
    if (this.pending.some(item => item.rpcId === undefined || item.rpcId === rpcId)) {
      this.observedRpcIds.add(rpcId)
    }
  }

  private reconcile(): void {
    this.pending = this.pending.flatMap((item): PendingSubmission[] => {
      if (item.rpcId === undefined || !this.observedRpcIds.has(item.rpcId)) return [item]
      return item.activity === undefined ? [] : [{ ...item, durablePromptObserved: true }]
    })
    this.pruneObservedRpcIds()
  }

  private pruneObservedRpcIds(): void {
    if (this.pending.some(item => item.rpcId === undefined)) return
    const active = new Set(this.pending.flatMap(item => item.rpcId === undefined ? [] : [item.rpcId]))
    for (const rpcId of this.observedRpcIds) {
      if (!active.has(rpcId)) this.observedRpcIds.delete(rpcId)
    }
  }
}
