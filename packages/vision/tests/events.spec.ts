import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { VisionObservationStage } from '../src/events.ts'

const ANALYSIS_ID = '00000000-0000-4000-8000-000000000001'
const attachment = {
  attachmentId: 'sha256:image-1',
  mediaType: 'image/png',
  bytes: 128,
  width: 16,
  height: 8,
  name: 'screen.png',
} as ImageAttachmentRef

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

function stageAnalysis(stage: VisionObservationStage, sessionId = 'session-1'): void {
  stage.set(ANALYSIS_ID, {
    sessionId,
    observation: '<vision-observation>evidence</vision-observation>',
    source: {
      kind: 'community-vision',
      analysisId: ANALYSIS_ID,
      provider: 'proxy',
      model: 'vision',
      attachments: [attachment],
      durationMs: 500,
      finishReason: 'stop',
      truncated: false,
    },
  })
}

describe('VisionObservationStage', () => {
  it('persists standard image blocks before admitting text-only messages', async () => {
    const { stage, invoke } = fixture()
    stageAnalysis(stage)
    const submission = stage.submission({
      analysisId: ANALYSIS_ID,
      sessionId: 'session-1',
      promptText: 'What failed?',
      mode: 'queue',
      rpcId: 'rpc-1',
      clientTimeZone: 'Asia/Shanghai',
    })

    expect(submission).toMatchObject({
      source: {
        kind: 'community-vision-submission',
        analysisId: ANALYSIS_ID,
        attachments: [attachment],
      },
      content: [
        { type: 'text', text: 'What failed?' },
        { type: 'community-vision-observation', text: '<vision-observation>evidence</vision-observation>' },
        { type: 'image', attachment },
      ],
    })

    const result = await invoke('session-1', { kind: 'enter', messages: [submission] })

    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') return
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({
      id: submission.id,
      source: { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Shanghai' },
      content: [{ type: 'text', text: 'What failed?' }],
    })
    expect(result.messages[1]).toMatchObject({
      source: { kind: 'community-vision', analysisId: ANALYSIS_ID, attachments: [attachment] },
      content: [{ type: 'text', text: '<vision-observation>evidence</vision-observation>' }],
    })
    expect(result.messages.flatMap(message => message.content)).not.toContainEqual(expect.objectContaining({ type: 'image' }))
  })

  it('can admit a durable submission after process-local staging is gone', async () => {
    const first = fixture()
    stageAnalysis(first.stage)
    const durable = first.stage.submission({
      analysisId: ANALYSIS_ID,
      sessionId: 'session-1',
      promptText: 'Resume safely',
      mode: 'queue',
      rpcId: 'rpc-resume',
    })
    const resumed = fixture()

    const result = await resumed.invoke('session-1', { kind: 'enter', messages: [durable] })

    expect(result).toMatchObject({
      kind: 'enter',
      messages: [
        { source: { kind: 'user', rpcId: 'rpc-resume' } },
        { source: { kind: 'community-vision', analysisId: ANALYSIS_ID } },
      ],
    })
  })

  it('rejects a durable submission attached to another session', async () => {
    const { stage, invoke } = fixture()
    stageAnalysis(stage)
    const submission = stage.submission({
      analysisId: ANALYSIS_ID,
      sessionId: 'session-1',
      promptText: 'question',
      mode: 'queue',
      rpcId: 'rpc-1',
    })

    await expect(invoke('session-2', { kind: 'enter', messages: [submission] })).resolves.toEqual({ kind: 'reject' })
  })
})
