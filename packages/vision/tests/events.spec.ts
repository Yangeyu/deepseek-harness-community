import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { VisionEvidenceAdmissionAdapter } from '../src/events.ts'
import type { VisionAnalysis } from '../src/types.ts'

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
  adapter: VisionEvidenceAdmissionAdapter
  invoke: (sessionId: string, decision: PreStepDecision) => Promise<PreStepDecision>
} {
  let handler: ((event: { agent: { id: string } }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>) | undefined
  const context = {
    on: (_name: string, value: typeof handler) => { handler = value },
  } as unknown as Context
  const adapter = new VisionEvidenceAdmissionAdapter(context)
  return {
    adapter,
    invoke: async (sessionId, decision) => {
      if (handler === undefined) throw new Error('pre-step handler was not registered')
      return handler({ agent: { id: sessionId } }, async () => decision)
    },
  }
}

function analysis(sessionId = 'session-1'): VisionAnalysis {
  return {
    analysisId: ANALYSIS_ID,
    sessionId,
    observation: '<vision-observation>evidence</vision-observation>',
    provider: 'proxy',
    model: 'vision',
    attachments: [attachment],
    durationMs: 500,
    finishReason: 'stop',
    truncated: false,
  }
}

describe('VisionEvidenceAdmissionAdapter', () => {
  it('carries verified image blocks into source-attributed text-only admission', async () => {
    const { adapter, invoke } = fixture()
    const submission = adapter.submission({
      analysis: analysis(),
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
      source: {
        kind: 'community-vision',
        promptId: submission.id,
        analysisId: ANALYSIS_ID,
        attachments: [attachment],
      },
      content: [{ type: 'text', text: '<vision-observation>evidence</vision-observation>' }],
    })
    expect(result.messages.flatMap(message => message.content)).not.toContainEqual(expect.objectContaining({ type: 'image' }))
  })

  it('admits a complete carrier without process-local analysis state', async () => {
    const first = fixture()
    const durable = first.adapter.submission({
      analysis: analysis(),
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
        { source: { kind: 'community-vision', promptId: durable.id, analysisId: ANALYSIS_ID } },
      ],
    })
  })

  it('rejects a durable submission attached to another session', async () => {
    const { adapter, invoke } = fixture()
    const submission = adapter.submission({
      analysis: analysis(),
      promptText: 'question',
      mode: 'queue',
      rpcId: 'rpc-1',
    })

    await expect(invoke('session-2', { kind: 'enter', messages: [submission] })).resolves.toEqual({ kind: 'reject' })
  })
})
