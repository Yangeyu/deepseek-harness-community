import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@vascent/deepseek-harness-vision'
import { describe, expect, it, vi } from 'vitest'
import {
  installPromptLifecycle,
  projectPromptNode,
} from '../../../src/runtime/lifecycle/index.ts'

function event(value: unknown): SessionEvent {
  return value as SessionEvent
}

function session(events: readonly SessionEvent[]): Session {
  return {
    id: 'session-1',
    header: { cwd: '/workspace' },
    events,
  } as unknown as Session
}

describe('Prompt lifecycle Host projection', () => {
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
        attachments: [expect.objectContaining({ attachmentId: 'attachment-native' })],
      },
    }))
  })

  it('enriches one proxy-image Prompt while ignoring its transport carrier', async () => {
    const start = event({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } })
    const carrier = event({
      type: 'user/message',
      seq: 1,
      time: 110,
      surfaceOp: 'append',
      data: {
        id: 'carrier',
        role: 'user',
        source: { kind: 'community-vision-submission', analysisId: 'analysis-1' },
        content: [{ type: 'text', text: 'inspect [Image #1] now' }],
      },
    })
    const prompt = event({
      type: 'user/message',
      seq: 2,
      time: 120,
      surfaceOp: 'append',
      data: {
        id: 'image-prompt',
        role: 'user',
        source: { kind: 'user', rpcId: 'rpc-1' },
        content: [{ type: 'text', text: 'inspect [Image #1] now' }],
      },
    })
    const evidence = event({
      type: 'user/message',
      seq: 3,
      time: 180,
      surfaceOp: 'append',
      data: {
        id: 'vision-evidence',
        role: 'user',
        source: {
          kind: 'community-vision',
          promptId: 'image-prompt',
          analysisId: 'analysis-1',
          attachments: [{
            attachmentId: 'attachment-1',
            mediaType: 'image/png',
            bytes: 4,
            width: 1,
            height: 1,
            name: 'image.png',
          }],
        },
        content: [{ type: 'text', text: 'objects in image' }],
      },
    })
    const current = session([start, carrier, prompt, evidence])
    const upsertPrompt = vi.fn()
    const ctx = new Context()
    installPromptLifecycle(ctx, { upsertPrompt })

    ctx.emit('session/event', current, carrier)
    ctx.emit('session/event', current, prompt)
    ctx.emit('session/event', current, evidence)

    expect(upsertPrompt).toHaveBeenCalledTimes(2)
    expect(upsertPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      promptId: 'image-prompt',
      turn: 1,
      input: {
        text: 'inspect [Image #1] now',
        attachments: [expect.objectContaining({ attachmentId: 'attachment-1' })],
      },
      position: 'turn-entry',
    }))
    await ctx.fiber.dispose()
  })

  it('associates delayed Vision evidence by Prompt identity instead of event proximity', () => {
    const start = event({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } })
    const first = event({
      type: 'user/message',
      seq: 1,
      time: 110,
      surfaceOp: 'append',
      data: {
        id: 'first-prompt',
        role: 'user',
        source: { kind: 'user', rpcId: 'rpc-1' },
        content: [{ type: 'text', text: 'first [Image #1]' }],
      },
    })
    const second = event({
      type: 'user/message',
      seq: 2,
      time: 120,
      surfaceOp: 'append',
      data: {
        id: 'second-prompt',
        role: 'user',
        source: { kind: 'user', rpcId: 'rpc-2' },
        content: [{ type: 'text', text: 'second' }],
      },
    })
    const evidence = event({
      type: 'user/message',
      seq: 3,
      time: 180,
      surfaceOp: 'append',
      data: {
        id: 'vision-evidence',
        role: 'user',
        source: {
          kind: 'community-vision',
          promptId: 'first-prompt',
          analysisId: 'analysis-1',
          attachments: [{
            attachmentId: 'attachment-1',
            mediaType: 'image/png',
            bytes: 4,
            width: 1,
            height: 1,
          }],
        },
        content: [{ type: 'text', text: 'evidence for first' }],
      },
    })
    const current = session([start, first, second, evidence])

    expect(projectPromptNode(current, evidence)).toEqual(expect.objectContaining({
      promptId: 'first-prompt',
      input: {
        text: 'first [Image #1]',
        attachments: [expect.objectContaining({ attachmentId: 'attachment-1' })],
      },
    }))
    expect(projectPromptNode(current, second)).toEqual(expect.objectContaining({
      promptId: 'second-prompt',
      input: { text: 'second', attachments: [] },
    }))
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
