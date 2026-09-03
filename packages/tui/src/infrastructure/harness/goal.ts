import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalService } from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal/types'
import type { GoalPort, GoalSessionSource } from '../../modules/task/contracts.ts'

/** Harness adapter for the Task module's consumer-owned Goal port. */
export class HarnessGoalPort implements GoalPort {
  constructor(
    private readonly controller: Pick<SessionController, 'resolveAgent'>,
    private readonly goals: Pick<GoalService, 'clear' | 'complete' | 'create' | 'edit' | 'pause' | 'resume'>,
    private readonly session: GoalSessionSource,
  ) {}

  async create(objective: string, maxGoalRounds?: number): Promise<GoalRef> {
    return this.goals.create(await this.requireAgent(), {
      objective,
      ...maxGoalRounds === undefined ? {} : { maxGoalRounds },
    })
  }

  async edit(ref: GoalRef, objective?: string, maxGoalRounds?: number): Promise<GoalRef> {
    return this.goals.edit(await this.requireAgent(), ref, {
      ...objective === undefined ? {} : { objective },
      ...maxGoalRounds === undefined ? {} : { maxGoalRounds },
    })
  }

  async pause(ref: GoalRef): Promise<GoalRef> {
    return this.goals.pause(await this.requireAgent(), ref)
  }

  async resume(ref: GoalRef): Promise<GoalRef> {
    return this.goals.resume(await this.requireAgent(), ref)
  }

  async complete(ref: GoalRef): Promise<GoalRef> {
    return this.goals.complete(await this.requireAgent(), ref)
  }

  async clear(ref: GoalRef): Promise<void> {
    this.goals.clear(await this.requireAgent(), ref)
  }

  private requireSession(): NonNullable<GoalSessionSource['current']['sessionId']> {
    const sessionId = this.session.current.sessionId
    if (sessionId === undefined) throw new Error('no terminal session is active')
    return sessionId
  }

  private async requireAgent(): Promise<Agent> {
    const result = await this.controller.resolveAgent(this.requireSession())
    if ('error' in result) throw new Error(result.error.message)
    return result.agent
  }
}
