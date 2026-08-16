import type {
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

  async list(sessionId: string): Promise<RewindPointSummary[]> {
    await this.rewind.settle(sessionId)
    return this.rewind.list(sessionId)
  }

  plan(sessionId: string, pointId: string): Promise<RewindPlan> {
    return this.rewind.plan(sessionId, pointId)
  }

  async execute(
    plan: RewindPlan,
    onPhase?: (phase: RewindTransactionPhase) => void,
  ): Promise<string> {
    const compensate = await this.rewind.restore(plan)
    let targetSessionId: string
    try {
      targetSessionId = await this.conversation.rewind(plan, phase => { onPhase?.(phase) })
    } catch (error: unknown) {
      onPhase?.('compensating')
      try {
        await compensate()
      } catch (compensationError: unknown) {
        throw new Error(`conversation rewind failed (${String(error)}) and compensation also failed (${String(compensationError)})`)
      }
      throw error
    }
    this.rewind.continueFrom(plan, targetSessionId)
    return targetSessionId
  }
}
