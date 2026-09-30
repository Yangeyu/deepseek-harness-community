import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { projectPromptNodes } from '../../../runtime/execution/projection/index.ts'
import type { RewindConversationHistory, RewindPointInput } from '../contracts.ts'
import { rewindPointFromPrompt } from './prompt.ts'

/** Query owns live and persisted history; Rewind only derives its conversation checkpoints. */
export class HostRewindConversationHistory implements RewindConversationHistory {
  constructor(private readonly ctx: Context) {}

  async list(sessionId: string): Promise<readonly RewindPointInput[]> {
    using observation = await this.ctx.sessionQuery.observeSession(sessionId as SessionId)
    return projectPromptNodes(observation.header, observation.events)
      .flatMap(prompt => {
        const point = rewindPointFromPrompt(prompt)
        return point === undefined ? [] : [point]
      })
  }
}
