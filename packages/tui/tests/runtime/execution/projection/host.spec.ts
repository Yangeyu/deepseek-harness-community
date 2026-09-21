import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { visionEvidenceBlock } from '../../../../src/runtime/session/input.ts'
import {
  installPromptProjection,
  projectPromptNode,
} from '../../../../src/runtime/execution/projection/index.ts'

function event(value: unknown): SessionEvent {
  return value as SessionEvent
}

function session(events: readonly SessionEvent[]): Session {
  return {
    id: 'session-1',
    header: { cwd: '/workspace' },
    snapshotEvents: () => events,
  } as unknown as Session
}

describe('Prompt execution Host projection', () => {
  it('projects an accepted user message as the stable prompt boundary', () => {
    const previous = event({
      type: 'turn/end',
      seq: 0,
      time: 100,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    const start = event({ type: 'turn/start', seq: 1, time: 200, data: { turn: 2 } })
    const prompt = event({
      type: 'user/message',
      seq: 2,
      time: 220,
      surfaceOp: 'append',
      data: {
        id: 'prompt-2',
        role: 'user',
        source: { kind: 'user', rpcId: 'rpc-2' },
        content: [{ type: 'text', text: 'inspect this' }],
      },
    })

    expect(projectPromptNode(session([previous, start, prompt]), prompt)).toEqual({
      promptId: 'prompt-2',
      sessionId: 'session-1',
      turn: 2,
      workspaceRoot: '/workspace',
      input: { text: 'inspect this', attachments: [] },
      position: 'turn-entry',
      admittedSeq: 2,
      admittedAt: 220,
      previousTurnEndSeq: 0,
    })
  })

  it('keeps native image references on their owning Prompt', () => {
    const start = event({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } })
    const prompt = event({
      type: 'user/message',
      seq: 1,
      time: 120,
      surfaceOp: 'append',
      data: {
        id: 'native-prompt',
        role: 'user',
        source: { kind: 'user', rpcId: 'rpc-1' },
        content: [{ type: 'text', text: '[Image #1]' }, {
          type: 'image',
          attachment: {
            attachmentId: 'attachment-native',
            mediaType: 'image/png',
            bytes: 4,
            width: 1,
            height: 1,
            name: 'native.png',
          },
        }],
      },
    })

    expect(projectPromptNode(session([start, prompt]), prompt)).toEqual(expect.objectContaining({
      promptId: 'native-prompt',
      input: {
        text: '[Image #1]',
        attachments: [{ reference: '[Image #1]', attachment: expect.objectContaining({ attachmentId: 'attachment-native' }) }],
      },
    }))
  })

  it('publishes complete native and proxy attachments atomically with the original Prompt', async () => {
    const native = {
      attachmentId: AttachmentId('attachment-native'), mediaType: 'image/png' as const,
      bytes: 4, width: 1, height: 1, name: 'native.png',
    }
    const proxy = { ...native, attachmentId: AttachmentId('attachment-proxy'), name: 'proxy.png' }
    const start = event({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } })
    const prompt = event({
      type: 'user/message', seq: 1, time: 180, surfaceOp: 'append',
      data: {
        id: 'image-prompt', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' },
        content: [
          { type: 'text', text: 'compare [Image #1]' },
          { type: 'image', attachment: native },
          { type: 'text', text: ' with [Image #2] now' },
          visionEvidenceBlock({
            analysisId: 'analysis-1', provider: 'bailian', model: 'qwen',
            observation: 'Objects in image', attachments: [proxy], references: ['[Image #2]'],
            durationMs: 60, truncated: false, finishReason: 'stop',
          }),
        ],
      },
    })
    const current = session([start, prompt])
    const upsertPrompt = vi.fn()
    const ctx = new Context()
    installPromptProjection(ctx, { upsertPrompt })

    ctx.emit('session/event', current, prompt)

    expect(upsertPrompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      promptId: 'image-prompt', turn: 1,
      input: {
        text: 'compare [Image #1] with [Image #2] now',
        attachments: [{ reference: '[Image #1]', attachment: native }, { reference: '[Image #2]', attachment: proxy }],
      },
      position: 'turn-entry', admittedSeq: 1, admittedAt: 180,
    }))
    await ctx.fiber.dispose()
  })

  it('does not create a point when a turn closes before prompt admission', () => {
    const start = event({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } })
    const end = event({
      type: 'turn/end',
      seq: 1,
      time: 110,
      data: { turn: 1, reason: { kind: 'interrupted' } },
    })
    const late = event({
      type: 'user/message',
      seq: 2,
      time: 120,
      surfaceOp: 'append',
      data: {
        id: 'late',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'late prompt' }],
      },
    })

    expect(projectPromptNode(session([start, end, late]), late)).toBeUndefined()
  })

  it('retains an in-turn human message without treating it as a turn entry', () => {
    const start = event({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } })
    const initial = event({
      type: 'user/message',
      seq: 1,
      time: 110,
      surfaceOp: 'append',
      data: {
        id: 'initial',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'start' }],
      },
    })
    const steering = event({
      type: 'user/message',
      seq: 2,
      time: 120,
      surfaceOp: 'append',
      data: {
        id: 'steering',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'adjust course' }],
      },
    })

    expect(projectPromptNode(session([start, initial, steering]), steering)).toEqual(expect.objectContaining({
      promptId: 'steering',
      position: 'in-turn',
    }))
  })
})
