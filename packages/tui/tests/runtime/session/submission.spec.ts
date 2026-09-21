import { describe, expect, it } from 'vitest'
import type {
  HistoryEntry,
  SessionRequestId,
} from '../../../src/runtime/session/contracts.ts'
import { SubmissionTracker } from '../../../src/runtime/session/submission.ts'

const requestId = 'rpc-prompt' as SessionRequestId

function userEvent(text: string): HistoryEntry {
  return {
    event: {
      type: 'user/message',
      seq: 1,
      time: 1,
      surfaceOp: 'append',
      data: {
        id: 'message-durable',
        role: 'user',
        source: { kind: 'user', rpcId: requestId },
        content: [{ type: 'text', text }],
      },
    },
  } as unknown as HistoryEntry
}

describe('SubmissionTracker', () => {
  it.each(['conversation', 'inbox'] as const)('reconciles %s admission that races ahead of the prompt response', (admission) => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('durable prompt', 'queue', false)
    expect(pending.intent).toBe('working')

    const entry = userEvent('durable prompt')
    const event = entry.event
    if (event.type !== 'user/message') throw new Error('expected user message')
    tracker.observeEvents([admission === 'conversation' ? entry : {
      event: { type: 'agent/inbox/spliced', seq: event.seq, time: event.time, data: { target: 'next-step', start: 0, inserted: [event.data] } },
    }])
    expect(tracker.snapshot).toEqual([pending])

    tracker.accept(pending.key, requestId)
    expect(tracker.snapshot).toEqual([])
  })

  it('retires an accepted prompt when its durable event arrives', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('durable prompt', 'steer', true)
    tracker.accept(pending.key, requestId)

    expect(tracker.snapshot[0]?.requestId).toBe(requestId)
    expect(tracker.snapshot[0]?.intent).toBe('steering')
    tracker.observeEvents([userEvent('durable prompt')])
    expect(tracker.snapshot).toEqual([])
  })

  it('distinguishes an explicit active-turn queue from a new working prompt', () => {
    const tracker = new SubmissionTracker()

    expect(tracker.start('later', 'queue', true).intent).toBe('queueing')
  })

  it('retires preparation activity with the complete prompt admission', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('analyze', 'queue', false)
    const analysisId = 'analysis-1'

    tracker.setActivity(pending.key, { kind: 'vision', analysisId, imageCount: 2 })
    expect(tracker.snapshot[0]).toMatchObject({
      key: pending.key,
      activity: { kind: 'vision', analysisId, imageCount: 2, startedAt: expect.any(Number) },
    })

    tracker.accept(pending.key, requestId)
    tracker.observeEvents([userEvent('analyze')])
    expect(tracker.snapshot).toEqual([])
  })

  it('retires command input that has no durable user-message event', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('/compact', 'queue', false)

    tracker.settle(pending.key)

    expect(tracker.snapshot).toEqual([])
  })
})
