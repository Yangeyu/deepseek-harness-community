import { describe, expect, it } from 'vitest'
import { rewindPointFromPrompt } from '../../src/rewind/index.ts'

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
})
