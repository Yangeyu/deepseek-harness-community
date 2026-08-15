import type {
  HistoryEntry,
  RpcId,
} from '@deepseek-ai/dsh-host-apiproxy'

/** Locally visible prompt retained until its durable user-message event is observed. */
export interface PendingSubmission {
  key: number
  text: string
  mode: 'queue' | 'steer'
  intent: 'working' | 'queueing' | 'steering'
  rpcId?: RpcId
}

function userMessageRpcId(entry: HistoryEntry): RpcId | undefined {
  const event = entry.event
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  return 'rpcId' in event.data.source ? event.data.source.rpcId : undefined
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

  /** Attach the echoed RPC identity or retire an already durable prompt. */
  accept(key: number, rpcId: RpcId): void {
    this.pending = this.observedRpcIds.has(rpcId)
      ? this.pending.filter(item => item.key !== key)
      : this.pending.map(item => item.key === key ? { ...item, rpcId } : item)
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
    for (const entry of entries) this.observe(userMessageRpcId(entry))
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
    this.pending = this.pending.filter(item =>
      item.rpcId === undefined || !this.observedRpcIds.has(item.rpcId))
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
