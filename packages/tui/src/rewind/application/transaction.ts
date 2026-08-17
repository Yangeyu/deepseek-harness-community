import type {
  RewindAction,
  RewindCompensation,
  RewindConversationPort,
  RewindPlan,
  RewindPointSummary,
  RewindPort,
} from '../contracts.ts'

export type RewindTransactionPhase = 'forking' | 'opening' | 'compensating'

/** Application transaction that commits conversation state after reversible participants. */
export class RewindTransaction {
  constructor(
    private readonly rewind: RewindPort,
    private readonly conversation: RewindConversationPort,
  ) {}

  async list(sessionId: string, workspaceRoot: string): Promise<RewindPointSummary[]> {
    await this.rewind.activate(sessionId, workspaceRoot)
    await this.rewind.settle(sessionId)
    return this.rewind.list(sessionId)
  }

  plan(sessionId: string, pointId: string): Promise<RewindPlan> {
    return this.rewind.plan(sessionId, pointId)
  }

  async execute(
    plan: RewindPlan,
    action: RewindAction,
    onPhase?: (phase: RewindTransactionPhase) => void,
  ): Promise<string> {
    const restoresCode = action !== 'conversation-only' && plan.codeScope === 'backward'
    const restoresConversation = action !== 'code-only'
    const compensate: RewindCompensation = restoresCode
      ? await this.rewind.restore(plan)
      : async () => {}
    let targetSessionId = plan.sessionId
    if (restoresConversation) {
      try {
        targetSessionId = await this.conversation.rewind(plan, phase => { onPhase?.(phase) })
      } catch (error: unknown) {
        if (restoresCode) {
          onPhase?.('compensating')
          try {
            await compensate()
          } catch (compensationError: unknown) {
            throw new Error(`conversation rewind failed (${String(error)}) and compensation also failed (${String(compensationError)})`)
          }
        }
        throw error
      }
    }
    try {
      await this.rewind.commit(
        plan,
        action,
        restoresConversation ? targetSessionId : undefined,
      )
    } catch (error: unknown) {
      if (restoresCode) {
        onPhase?.('compensating')
        try {
          await compensate()
        } catch (compensationError: unknown) {
          throw new Error(`Rewind commit failed (${String(error)}) and compensation also failed (${String(compensationError)})`)
        }
      }
      throw error
    }
    return targetSessionId
  }
}
