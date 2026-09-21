import { randomUUID } from 'node:crypto'
import type {
  HistoryEntry,
  QueuedInboxItem,
  SessionRequestId,
} from './contracts.ts'
import { promptTextFromContent } from '../execution/prompt-text.ts'

export interface PendingVisionActivity {
  kind: 'vision'
  analysisId: string
  imageCount: number
  startedAt: number
}

export type PendingSubmissionActivity = PendingVisionActivity
export type SubmissionActivityUpdate = Omit<PendingVisionActivity, 'startedAt'>

/** A local submission or a consumed inbox message awaiting its conversation row. */
export type PendingSubmission = {
  key: number
  text: string
  intent: 'working' | 'queueing' | 'steering'
  activity?: PendingSubmissionActivity
} & (
  | { requestId: SessionRequestId; messageId?: string }
  | { requestId?: never; messageId: string }
)

/** Keeps prompt presentation continuous across preparation, inbox, and conversation. */
export class SubmissionTracker {
  private nextKey = 0
  private pending: PendingSubmission[] = []
  private readonly handoffs = new Map<number, { turn: number | undefined; consumedAt: number }>()
  private turn: number | undefined

  get snapshot(): PendingSubmission[] {
    return [...this.pending]
  }

  get activeTurn(): number | undefined {
    return this.turn
  }

  start(text: string, mode: 'queue' | 'steer', running: boolean): PendingSubmission & { requestId: SessionRequestId } {
    const intent = mode === 'steer' ? 'steering' : running ? 'queueing' : 'working'
    const submission = { key: ++this.nextKey, requestId: randomUUID() as SessionRequestId, text, intent } as const
    this.pending = [...this.pending, submission]
    return submission
  }

  setActivity(key: number, activity: SubmissionActivityUpdate): void {
    this.pending = this.pending.map(item => item.key === key
      ? { ...item, activity: { ...activity, startedAt: Date.now() } }
      : item)
  }

  reject(key: number): void {
    this.settle(key)
  }

  private settle(key: number): void {
    this.pending = this.pending.filter(item => item.key !== key)
    this.handoffs.delete(key)
  }

  /** The inbox and retirement of its local echo are published in one snapshot. */
  observeQueue(queue: readonly QueuedInboxItem[]): void {
    this.retireQueue(queue)
  }

  retireQueue(queue: readonly QueuedInboxItem[]): void {
    for (const item of this.pending) {
      if (queue.some(row => row.id === item.messageId
        || (row.rpcId !== undefined && row.rpcId === item.requestId))) this.settle(item.key)
    }
  }

  /** A consumed message can wait through asynchronous pre-step work before user/message. */
  handoff(queue: readonly QueuedInboxItem[], turn: number | undefined, consumedAt: number): void {
    this.retireQueue(queue)
    for (const row of queue) {
      if (row.placement === 'context') continue
      const submission: PendingSubmission = {
        key: ++this.nextKey,
        messageId: String(row.message.id),
        ...row.rpcId === undefined ? {} : { requestId: row.rpcId },
        text: promptTextFromContent(row.message.content),
        intent: 'working',
      }
      this.pending = [...this.pending, submission]
      this.handoffs.set(submission.key, { turn, consumedAt })
    }
  }

  observeEvents(entries: readonly HistoryEntry[]): void {
    for (const { event } of entries) {
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        for (const [key, handoff] of this.handoffs) {
          // Reconnect pages may include older boundaries or omit the original turn/end.
          if (event.seq <= handoff.consumedAt) continue
          if (handoff.turn === undefined || (event.type === 'turn/end'
            ? event.data.turn >= handoff.turn : event.data.turn > handoff.turn)) this.settle(key)
        }
        if (event.type === 'turn/start') this.turn = event.data.turn
        else if (this.turn === undefined || this.turn <= event.data.turn) this.turn = undefined
      }
      if (event.type !== 'user/message' || event.surfaceOp !== 'append') continue
      const source = event.data.source
      const requestId = source.kind === 'user' && 'rpcId' in source ? source.rpcId : undefined
      for (const item of this.pending) {
        if (item.messageId === event.data.id
          || (requestId !== undefined && item.requestId === requestId)) this.settle(item.key)
      }
    }
  }
}
