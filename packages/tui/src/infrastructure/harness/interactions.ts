import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type {
  SessionInteractionHandler,
  SessionInteractionSource,
} from '../../runtime/session/interactions.ts'

/** Connect the TUI's local interaction lifecycle to Host-scoped waterfalls. */
export class HarnessInteractionSource implements SessionInteractionSource {
  constructor(private readonly ctx: Context) {}

  connect(handler: SessionInteractionHandler): () => void {
    const removeApproval = this.ctx.on('approval/request', async (request, next) => {
      const answer = await handler.approval({
        requestId: randomUUID(),
        sessionId: request.agent.id,
        toolName: request.toolName,
        ...request.callId === undefined ? {} : { callId: request.callId },
        ...request.reason === undefined ? {} : { reason: request.reason },
        ...request.signal === undefined ? {} : { signal: request.signal },
      })
      return answer === undefined ? next() : answer
    })
    const removeQuestions = this.ctx.on('user-questions/request', async (request, next) => {
      if (request.agent === undefined) return next()
      const answer = await handler.questions({
        requestId: randomUUID(),
        sessionId: request.agent.id,
        questions: request.questions,
        ...request.signal === undefined ? {} : { signal: request.signal },
      })
      return answer === undefined ? next() : answer
    })
    return () => {
      removeQuestions()
      removeApproval()
    }
  }
}
