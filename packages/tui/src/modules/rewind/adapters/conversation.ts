import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { RewindConversationHistory, RewindPointInput } from '../contracts.ts'
import { rewindPointFromPrompt } from './prompt.ts'

/** Read the bounded checkpoint projection, without scanning Session history. */
export class HostRewindConversationHistory implements RewindConversationHistory {
  constructor(private readonly ctx: Context) {}

  async list(sessionId: string): Promise<readonly RewindPointInput[]> {
    const session = this.ctx.agents.get(sessionId as SessionId)?.session
    if (session === undefined) throw new Error('the active conversation history is unavailable')
    const history = this.ctx.sessionProjections.stateOf(session, 'communityPrompts')
    if (history === undefined) throw new Error('the prompt history projection is unavailable')
    return history.checkpoints.map(prompt => rewindPointFromPrompt(prompt)!)
  }
}
