import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { VisionObservationStage } from '../src/events.ts'

const ANALYSIS_ID = '00000000-0000-4000-8000-000000000001'

function fixture(): {
  stage: VisionObservationStage
  invoke: (sessionId: string, decision: PreStepDecision) => Promise<PreStepDecision>
} {
  let handler: ((event: { agent: { id: string } }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>) | undefined
  const context = {
    on: (_name: string, value: typeof handler) => { handler = value },
  } as unknown as Context
  const stage = new VisionObservationStage(context)
  return {
    stage,
    invoke: async (sessionId, decision) => {
      if (handler === undefined) throw new Error('pre-step handler was not registered')
      return handler({ agent: { id: sessionId } }, async () => decision)
    },
  }
}

describe('VisionObservationStage', () => {
  it('injects untrusted evidence once and preserves the original user message identity', async () => {
    const { stage, invoke } = fixture()
    stage.set(ANALYSIS_ID, {
      sessionId: 'session-1',
      observation: '<vision-observation>evidence</vision-observation>',
      source: {
        kind: 'community-vision',
        analysisId: ANALYSIS_ID,
        provider: 'proxy',
        model: 'vision',
        attachments: [],
        durationMs: 500,
        finishReason: 'stop',
        truncated: false,
      },
    })
    const original = createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'text', text: stage.marker(ANALYSIS_ID) },
        { type: 'text', text: 'What failed?' },
      ],
    })

    const result = await invoke('session-1', { kind: 'enter', messages: [original] })

    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') return
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({
      id: original.id,
      source: original.source,
      content: [{ type: 'text', text: 'What failed?' }],
    })
    expect(result.messages[1]?.source).toMatchObject({
      kind: 'community-vision',
      analysisId: ANALYSIS_ID,
    })
  })

  it('rejects a marker that does not belong to the active session', async () => {
    const { stage, invoke } = fixture()
    stage.set(ANALYSIS_ID, {
      sessionId: 'session-1',
      observation: 'evidence',
      source: {
        kind: 'community-vision',
        analysisId: ANALYSIS_ID,
        provider: 'proxy',
        model: 'vision',
        attachments: [],
        durationMs: 500,
        finishReason: 'stop',
        truncated: false,
      },
    })
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: stage.marker(ANALYSIS_ID) }, { type: 'text', text: 'question' }],
    })

    await expect(invoke('session-2', { kind: 'enter', messages: [message] })).resolves.toEqual({ kind: 'reject' })
  })
})
