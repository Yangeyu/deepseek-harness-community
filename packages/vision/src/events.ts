import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  freezeMessage,
  type MessageId,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  VisionEvidenceMetadata,
  VisionEvidenceSource,
  VisionAdmissionRequest,
  VisionSubmissionSource,
} from './types.ts'

// Keep completed analyses available until atomic admission while bounding
// process-local work abandoned by cancellation or a session change.
const STAGE_TTL_MS = 24 * 60 * 60 * 1_000

interface StagedObservation {
  sessionId: string
  observation: string
  expiresAt: number
  source: VisionEvidenceMetadata
}

function evidenceSource(
  source: VisionSubmissionSource,
  promptId: MessageId,
  attachments = source.attachments,
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

/** Two-phase bridge from process-local analysis to durable media and text-only model input. */
export class VisionObservationStage {
  private readonly staged = new Map<string, StagedObservation>()

  constructor(ctx: Context) {
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      this.expire()
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

  set(analysisId: string, observation: Omit<StagedObservation, 'expiresAt'>): void {
    this.staged.set(analysisId, { ...observation, expiresAt: Date.now() + STAGE_TTL_MS })
  }

  submission(request: VisionAdmissionRequest): UserMessage {
    this.expire()
    const staged = this.staged.get(request.analysisId)
    if (staged === undefined || staged.sessionId !== request.sessionId) {
      throw new Error('Vision analysis is no longer available for this session.')
    }
    const source: VisionSubmissionSource = {
      kind: 'community-vision-submission',
      sessionId: request.sessionId,
      rpcId: request.rpcId,
      analysisId: staged.source.analysisId,
      provider: staged.source.provider,
      model: staged.source.model,
      attachments: staged.source.attachments,
      durationMs: staged.source.durationMs,
      finishReason: staged.source.finishReason,
      truncated: staged.source.truncated,
      ...request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone },
      ...staged.source.usage === undefined ? {} : { usage: staged.source.usage },
    }
    return createUserMessage({
      source,
      content: [
        { type: 'text', text: request.promptText },
        { type: 'community-vision-observation', text: staged.observation },
        ...staged.source.attachments.map(attachment => ({ type: 'image' as const, attachment })),
      ],
    })
  }

  discard(analysisId: string): void {
    this.staged.delete(analysisId)
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, staged] of this.staged) {
      if (staged.expiresAt <= now) this.staged.delete(id)
    }
  }
}
