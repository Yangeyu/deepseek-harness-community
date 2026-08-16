import { describe, expect, it } from 'vitest'
import type {
  HistoryEntry,
  RpcId,
} from '@deepseek-ai/dsh-host-apiproxy'
import { SubmissionTracker } from '../../src/runtime/submission.ts'

const rpcId = 'rpc-prompt' as RpcId

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
        source: { kind: 'user', rpcId },
        content: [{ type: 'text', text }],
      },
    },
  } as HistoryEntry
}

describe('SubmissionTracker', () => {
  it('reconciles a durable event that races ahead of the prompt response', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('durable prompt', 'queue', false)
    expect(pending.intent).toBe('working')

    tracker.observeEvents([userEvent('durable prompt')])
    expect(tracker.snapshot).toEqual([pending])

    tracker.accept(pending.key, rpcId)
    expect(tracker.snapshot).toEqual([])
  })

  it('retires an accepted prompt when its durable event arrives', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('durable prompt', 'steer', true)
    tracker.accept(pending.key, rpcId)

    expect(tracker.snapshot[0]?.rpcId).toBe(rpcId)
    expect(tracker.snapshot[0]?.intent).toBe('steering')
    tracker.observeEvents([userEvent('durable prompt')])
    expect(tracker.snapshot).toEqual([])
  })

  it('distinguishes an explicit active-turn queue from a new working prompt', () => {
    const tracker = new SubmissionTracker()

    expect(tracker.start('later', 'queue', true).intent).toBe('queueing')
  })

  it('tracks a transient Vision phase without replacing prompt identity', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('analyze', 'queue', false)

    tracker.setActivity(pending.key, { kind: 'vision', imageCount: 2 })
    expect(tracker.snapshot[0]).toMatchObject({
      key: pending.key,
      activity: { kind: 'vision', imageCount: 2, startedAt: expect.any(Number) },
    })

    tracker.setActivity(pending.key, undefined)
    expect(tracker.snapshot).toEqual([pending])
  })

  it('retires command input that has no durable user-message event', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('/compact', 'queue', false)

    tracker.settle(pending.key)

    expect(tracker.snapshot).toEqual([])
  })
})
