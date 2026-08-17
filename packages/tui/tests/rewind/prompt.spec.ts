import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { rewindPointFromPrompt, rewindPointsFromSession } from '../../src/rewind/index.ts'

describe('Rewind Prompt adapter', () => {
  it('preserves lifecycle identity, time, and conversation boundary', () => {
    expect(rewindPointFromPrompt({
      promptId: 'message-1',
      sessionId: 'session-1',
      turn: 2,
      workspaceRoot: '/workspace',
      input: { text: 'inspect image', attachments: [] },
      position: 'turn-entry',
      admittedSeq: 8,
      admittedAt: 200,
      previousTurnEndSeq: 5,
    })).toEqual({
      pointId: 'message-1',
      sessionId: 'session-1',
      turn: 2,
      workspaceRoot: '/workspace',
      input: { text: 'inspect image', attachments: [] },
      promptSeq: 8,
      createdAt: 200,
      previousTurnEndSeq: 5,
    })
  })

  it('does not expose an in-turn Prompt as an unsupported conversation boundary', () => {
    expect(rewindPointFromPrompt({
      promptId: 'message-2',
      sessionId: 'session-1',
      turn: 2,
      workspaceRoot: '/workspace',
      input: { text: 'adjust course', attachments: [] },
      position: 'in-turn',
      admittedSeq: 9,
      admittedAt: 210,
      previousTurnEndSeq: 5,
    })).toBeUndefined()
  })

  it('rebuilds checkpoints for completed and active turns from one Session log', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 11,
        surfaceOp: 'append',
        data: {
          id: 'prompt-1',
          role: 'user',
          source: { kind: 'user', rpcId: 'rpc-1' },
          content: [{ type: 'text', text: 'first' }],
        },
      },
      { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 20, data: { turn: 2 } },
      {
        type: 'user/message',
        seq: 4,
        time: 21,
        surfaceOp: 'append',
        data: {
          id: 'prompt-2',
          role: 'user',
          source: { kind: 'user', rpcId: 'rpc-2' },
          content: [{ type: 'text', text: 'second' }],
        },
      },
    ] as unknown as SessionEvent[]
    const session = {
      id: 'session-1',
      header: { cwd: '/workspace' },
      events,
    } as unknown as Session

    expect(rewindPointsFromSession(session)).toEqual([
      expect.objectContaining({ pointId: 'prompt-1', turn: 1, input: { text: 'first', attachments: [] } }),
      expect.objectContaining({ pointId: 'prompt-2', turn: 2, previousTurnEndSeq: 2 }),
    ])
  })
})
