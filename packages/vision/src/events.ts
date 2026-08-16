import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'

const PLUGIN_NAME = 'community-vision'
// Keep one-use observations available across long-running or queued turns while
// still bounding abandoned process-local entries.
const STAGE_TTL_MS = 24 * 60 * 60 * 1_000
const MARKER_PREFIX = '<!-- dsh-vision-analysis:'
const MARKER_SUFFIX = ' -->'

interface StagedObservation {
  sessionId: string
  observation: string
  expiresAt: number
  summary: string
}

function markerId(block: ContentBlock): string | undefined {
  if (block.type !== 'text' || !block.text.startsWith(MARKER_PREFIX) || !block.text.endsWith(MARKER_SUFFIX)) {
    return undefined
  }
  const id = block.text.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id) ? id : undefined
}

function withoutMarker(message: UserMessage, content: ContentBlock[]): UserMessage {
  return { ...message, content }
}

/** One-use bridge from a completed proxy analysis to the next exact user message. */
export class VisionObservationStage {
  private readonly staged = new Map<string, StagedObservation>()

  constructor(ctx: Context) {
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      this.expire()
      const messages: UserMessage[] = []
      for (const message of decision.messages) {
        const ids = message.content.map(markerId).filter((id): id is string => id !== undefined)
        if (ids.length === 0) {
          messages.push(message)
          continue
        }
        if (ids.length !== 1) return { kind: 'reject' }
        const analysisId = ids[0]
        if (analysisId === undefined) return { kind: 'reject' }
        const staged = this.staged.get(analysisId)
        if (staged === undefined || staged.sessionId !== String(agent.id)) return { kind: 'reject' }
        const content = message.content.filter(block => markerId(block) === undefined)
        if (content.length === 0) return { kind: 'reject' }
        this.staged.delete(analysisId)
        messages.push(createUserMessage({
          content: [{ type: 'text', text: staged.observation }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: staged.summary },
        }))
        messages.push(withoutMarker(message, content))
      }
      return { kind: 'enter', messages }
    })
  }

  marker(analysisId: string): string {
    return `${MARKER_PREFIX}${analysisId}${MARKER_SUFFIX}`
  }

  set(analysisId: string, observation: Omit<StagedObservation, 'expiresAt'>): void {
    this.staged.set(analysisId, { ...observation, expiresAt: Date.now() + STAGE_TTL_MS })
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
