import { describe, expect, it } from 'vitest'
import type {
  HistoryEntry,
  QueuedInboxItem,
  SessionRequestId,
} from '../../../src/runtime/session/contracts.ts'
import { SubmissionTracker } from '../../../src/runtime/session/submission.ts'

function userEvent(text: string, requestId?: SessionRequestId): HistoryEntry {
  return {
    event: {
      type: 'user/message', seq: 1, time: 1, surfaceOp: 'append',
      data: {
        id: 'message-durable', role: 'user',
        source: { kind: 'user', ...requestId === undefined ? {} : { rpcId: requestId } },
        content: [{ type: 'text', text }],
      },
    },
  } as unknown as HistoryEntry
}

function queued(requestId?: SessionRequestId): QueuedInboxItem {
  return {
    id: 'message-durable', placement: 'steering',
    ...requestId === undefined ? {} : { rpcId: requestId },
    message: { id: 'message-durable', content: [{ type: 'text', text: 'full prompt\nsecond line' }] },
  } as unknown as QueuedInboxItem
}

function turnEnd(turn: number): HistoryEntry {
  return { event: { type: 'turn/end', seq: 2, time: 2, data: { turn, reason: { kind: 'aborted', reason: 'interrupted' } } } } as unknown as HistoryEntry
}

describe('SubmissionTracker', () => {
  it('assigns identity before publishing and retires when history takes over', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('durable prompt', 'queue', false)
    expect(pending.requestId).toBeTruthy()
    expect(pending.intent).toBe('working')
    const other = tracker.start('durable prompt', 'queue', true)
    expect(other.requestId).not.toBe(pending.requestId)
    expect(other.intent).toBe('queueing')

    tracker.observeEvents([userEvent('durable prompt', pending.requestId)])
    expect(tracker.snapshot).toEqual([other])
  })

  it('hands the complete local prompt and preparation activity over to a visible inbox row', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('analyze', 'steer', true)
    tracker.setActivity(pending.key, { kind: 'vision', analysisId: 'analysis-1', imageCount: 2 })
    expect(tracker.snapshot[0]).toMatchObject({
      requestId: pending.requestId, intent: 'steering',
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 2, startedAt: expect.any(Number) },
    })

    tracker.observeQueue([queued(pending.requestId)])
    expect(tracker.snapshot).toEqual([])
  })

  it.each([undefined, 'remote-rpc' as SessionRequestId])('holds the full consumed prompt until its conversation row, with rpc %s', (requestId) => {
    const tracker = new SubmissionTracker()
    tracker.handoff([queued(requestId)], 1, 0)
    expect(tracker.snapshot).toEqual([expect.objectContaining({
      messageId: 'message-durable', text: 'full prompt\nsecond line', intent: 'working',
    })])

    tracker.observeEvents([userEvent('full prompt\nsecond line', requestId)])
    expect(tracker.snapshot).toEqual([])
  })

  it.each([1, undefined])('retires consumed input at turn end without dropping a new submission (known turn: %s)', (turn) => {
    const tracker = new SubmissionTracker()
    tracker.handoff([queued()], turn, 0)
    const preparing = tracker.start('next prompt', 'queue', true)
    expect(tracker.snapshot).toHaveLength(2)
    tracker.observeEvents([turnEnd(1)])
    expect(tracker.snapshot).toEqual([preparing])
  })

  it('removes failed local preparation without affecting another prompt', () => {
    const tracker = new SubmissionTracker()
    const first = tracker.start('first', 'queue', false)
    const second = tracker.start('second', 'queue', false)
    tracker.reject(first.key)
    expect(tracker.snapshot).toEqual([second])
  })
})
