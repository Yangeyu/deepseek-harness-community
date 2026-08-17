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
  } as unknown as HistoryEntry
}

function visionEvent(analysisId: string): HistoryEntry {
  return {
    event: {
      type: 'user/message',
      seq: 2,
      time: 2,
      surfaceOp: 'append',
      data: {
        id: 'message-vision',
        role: 'user',
        source: {
          kind: 'community-vision',
          promptId: 'message-durable',
          analysisId,
          provider: 'proxy',
          model: 'vision',
          attachments: [],
          durationMs: 10,
          finishReason: 'stop',
          truncated: false,
        },
        content: [{ type: 'text', text: 'visual evidence' }],
      },
    },
  } as unknown as HistoryEntry
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

  it('keeps Vision activity until its durable analysis event takes over', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('analyze', 'queue', false)
    const analysisId = 'analysis-1'

    tracker.setActivity(pending.key, { kind: 'vision', analysisId, imageCount: 2 })
    expect(tracker.snapshot[0]).toMatchObject({
      key: pending.key,
      activity: { kind: 'vision', analysisId, imageCount: 2, startedAt: expect.any(Number) },
    })

    tracker.accept(pending.key, rpcId)
    tracker.observeEvents([userEvent('analyze')])
    expect(tracker.snapshot[0]).toMatchObject({ durablePromptObserved: true, activity: { analysisId } })

    tracker.observeEvents([visionEvent(analysisId)])
    expect(tracker.snapshot).toEqual([])
  })

  it('retires command input that has no durable user-message event', () => {
    const tracker = new SubmissionTracker()
    const pending = tracker.start('/compact', 'queue', false)

    tracker.settle(pending.key)

    expect(tracker.snapshot).toEqual([])
  })
})
