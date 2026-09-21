import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { InboxWireState } from '@deepseek-ai/dsh-agent'
import type {
  HistoryEntry,
  QueuedInboxItem,
  SessionId,
  SessionRequestId,
} from '../../../src/runtime/session/contracts.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { SessionRuntime } from '../../../src/runtime/session/runtime.ts'
import { SubmissionTracker } from '../../../src/runtime/session/submission.ts'

const runtimes: SessionRuntime[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())) })

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

  it.each([
    { mode: 'queue', running: false, placement: 'queued', intent: 'working', localEcho: true },
    { mode: 'queue', running: true, placement: 'queued', intent: 'queueing', localEcho: undefined },
    { mode: 'steer', running: true, placement: 'steering', intent: 'steering', localEcho: undefined },
  ] as const)('preserves $intent ownership from local preparation through inbox consumption', ({ mode, running, placement, intent, localEcho }) => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('full prompt\nsecond line', mode, running)
    tracker.setActivity(pending.key, { kind: 'vision', analysisId: 'analysis-1', imageCount: 2 })
    expect(tracker.snapshot[0]).toMatchObject({
      requestId: pending.requestId, intent,
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 2, startedAt: expect.any(Number) },
    })

    const queue = tracker.observeQueue([{ ...queued(pending.requestId), placement }])
    expect(queue[0]?.localEcho).toBe(localEcho)
    expect(tracker.snapshot).toEqual([])
    tracker.handoff(queue, 1, 0)
    expect(tracker.snapshot).toEqual([{
      key: expect.any(Number), requestId: pending.requestId, messageId: 'message-durable',
      text: 'full prompt\nsecond line', intent,
    }])
    tracker.observeEvents([userEvent('full prompt\nsecond line', pending.requestId)])
    expect(tracker.snapshot).toEqual([])
  })

  it.each([undefined, 'remote-rpc' as SessionRequestId])('holds the full consumed prompt until its conversation row, with rpc %s', (requestId) => {
    const tracker = new SubmissionTracker()
    tracker.handoff([queued(requestId)], 1, 0)
    expect(tracker.snapshot).toEqual([expect.objectContaining({
      messageId: 'message-durable', text: 'full prompt\nsecond line', intent: 'steering',
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

  it('does not create a consumed preview for context rows', () => {
    const tracker = new SubmissionTracker()
    tracker.handoff([{ ...queued(), placement: 'context' }], 1, 0)
    expect(tracker.snapshot).toEqual([])
  })

  it.each(['hydrate', 'append'] as const)('atomically transfers idle echo ownership via %s and retains it through snapshot and in-place replacement', (admission) => {
    const runtime = new SessionRuntime(new LifecycleScope('submission'), 'test-session' as SessionId, 1, '/workspace', {
      events: 'online', control: 'online',
    })
    runtimes.push(runtime)
    const pending = runtime.startSubmission('full prompt\nsecond line', 'queue')!
    runtime.setSubmissionActivity(pending.key, { kind: 'vision', analysisId: 'analysis-1', imageCount: 1 })
    const message = createUserMessage({
      content: [{ type: 'text', text: pending.text }], source: { kind: 'user', rpcId: pending.requestId },
    })
    const inbox = { 'next-turn': [message], 'next-step': [] } as unknown as InboxWireState
    const admissionEvent = { event: {
      type: 'agent/inbox/spliced', seq: 1, time: 1,
      data: { target: 'next-turn', start: 0, inserted: [message] },
    } } as HistoryEntry
    const snapshots: { local: number; inline: number }[] = []
    const unsubscribe = runtime.subscribe(snapshot => {
      snapshots.push({ local: snapshot.pendingSubmissions.length, inline: snapshot.queue.filter(row => row.localEcho).length })
    })
    if (admission === 'hydrate') {
      runtime.hydrate({ events: [], hasMore: false, projections: { asOfSeq: 1, values: { inbox } } }, 1)
    } else {
      expect(runtime.appendEvent(admissionEvent)).toBe('appended')
    }
    expect(snapshots).toEqual([{ local: 0, inline: 1 }])
    unsubscribe()

    const replaced = { event: {
      ...admissionEvent.event, seq: 2, time: 2,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [message] },
    } } as HistoryEntry
    expect(runtime.appendEvent(replaced)).toBe('appended')
    expect(runtime.current.queue[0]?.localEcho).toBe(true)
    expect(runtime.current.pendingSubmissions).toEqual([])
    runtime.hydrate({ events: [], hasMore: false, projections: { asOfSeq: 2, values: { inbox } } }, 2)
    expect(runtime.current.queue[0]?.localEcho).toBe(true)

    expect(runtime.appendEvent({ event: {
      type: 'agent/inbox/spliced', seq: 3, time: 3,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    } } as unknown as HistoryEntry)).toBe('appended')
    expect(runtime.current.queue).toEqual([])
    expect(runtime.current.pendingSubmissions).toEqual([{
      key: expect.any(Number), requestId: pending.requestId, messageId: message.id,
      text: pending.text, intent: 'working',
    }])
  })

  it('removes failed local preparation without affecting another prompt', () => {
    const tracker = new SubmissionTracker()
    const first = tracker.start('first', 'queue', false)
    const second = tracker.start('second', 'queue', false)
    tracker.reject(first.key)
    expect(tracker.snapshot).toEqual([second])
  })
})
