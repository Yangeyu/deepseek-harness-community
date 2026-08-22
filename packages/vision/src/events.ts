import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  freezeMessage,
  type MessageId,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  VisionEvidenceSource,
  VisionAdmissionRequest,
  VisionSubmissionSource,
} from './types.ts'

function evidenceSource(
  source: VisionSubmissionSource,
  promptId: MessageId,
  attachments: VisionSubmissionSource['attachments'],
): VisionEvidenceSource {
  return {
    kind: 'community-vision',
    promptId,
    analysisId: source.analysisId,
    provider: source.provider,
    model: source.model,
    attachments,
    durationMs: source.durationMs,
    finishReason: source.finishReason,
    truncated: source.truncated,
    ...source.usage === undefined ? {} : { usage: source.usage },
  }
}

function isSubmission(message: UserMessage): message is UserMessage & { source: VisionSubmissionSource } {
  return message.source.kind === 'community-vision-submission'
}

function matchesAttachments(message: UserMessage & { source: VisionSubmissionSource }): boolean {
  const images = message.content.slice(2)
  return images.length === message.source.attachments.length
    && images.every((block, index) => block.type === 'image'
      && String(block.attachment.attachmentId) === String(message.source.attachments[index]?.attachmentId))
}

function admittedMessages(message: UserMessage & { source: VisionSubmissionSource }): UserMessage[] | undefined {
  const prompt = message.content[0]
  const observation = message.content[1]
  if (prompt?.type !== 'text'
    || observation?.type !== 'community-vision-observation'
    || !matchesAttachments(message)) return undefined
  const source = message.source
  const attachments = message.content.slice(2).flatMap(block => block.type === 'image' ? [block.attachment] : [])
  const user = freezeMessage({
    ...message,
    content: [prompt],
    source: {
      kind: 'user' as const,
      rpcId: source.rpcId,
      ...source.clientTimeZone === undefined ? {} : { clientTimeZone: source.clientTimeZone },
    },
  })
  const evidence = createUserMessage({
    content: [{ type: 'text', text: observation.text }],
    source: evidenceSource(source, user.id, attachments),
  })
  return [user, evidence]
}

/** Narrow bridge until Agent admission can atomically accept multiple user messages. */
export class VisionEvidenceAdmissionAdapter {
  constructor(ctx: Context) {
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const messages: UserMessage[] = []
      for (const message of decision.messages) {
        if (!isSubmission(message)) {
          messages.push(message)
          continue
        }
        if (message.source.sessionId !== String(agent.id)) return { kind: 'reject' }
        const admitted = admittedMessages(message)
        if (admitted === undefined) return { kind: 'reject' }
        messages.push(...admitted)
      }
      return { kind: 'enter', messages }
    })
  }

  submission(request: VisionAdmissionRequest): UserMessage {
    const analysis = request.analysis
    const source: VisionSubmissionSource = {
      kind: 'community-vision-submission',
      sessionId: analysis.sessionId,
      rpcId: request.rpcId,
      analysisId: analysis.analysisId,
      provider: analysis.provider,
      model: analysis.model,
      attachments: analysis.attachments,
      durationMs: analysis.durationMs,
      finishReason: analysis.finishReason,
      truncated: analysis.truncated,
      ...request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone },
      ...analysis.usage === undefined ? {} : { usage: analysis.usage },
    }
    return createUserMessage({
      source,
      content: [
        { type: 'text', text: request.promptText },
        { type: 'community-vision-observation', text: analysis.observation },
        ...analysis.attachments.map(attachment => ({ type: 'image' as const, attachment })),
      ],
    })
  }
}
