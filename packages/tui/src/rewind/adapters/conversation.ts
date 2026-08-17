import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { projectPromptNode } from '../../runtime/lifecycle/index.ts'
import type { RewindConversationHistory, RewindPointInput } from '../contracts.ts'
import { rewindPointFromPrompt } from './prompt.ts'

/** Rebuild every turn-entry checkpoint from the canonical append-only Session log. */
export function rewindPointsFromSession(session: Session): readonly RewindPointInput[] {
  const points = new Map<string, RewindPointInput>()
  for (const event of session.events) {
    const prompt = projectPromptNode(session, event)
    if (prompt === undefined) continue
    const point = rewindPointFromPrompt(prompt)
    if (point !== undefined) points.set(point.pointId, point)
  }
  return [...points.values()].sort((left, right) => left.promptSeq - right.promptSeq)
}

/** Read Prompt checkpoints from the canonical, already-loaded Host Session log. */
export class HostRewindConversationHistory implements RewindConversationHistory {
  constructor(private readonly ctx: Context) {}

  list(sessionId: string): readonly RewindPointInput[] {
    const session = this.ctx.agents.get(sessionId as SessionId)?.session
    if (session === undefined) throw new Error('the active conversation history is unavailable')
    return rewindPointsFromSession(session)
  }
}
