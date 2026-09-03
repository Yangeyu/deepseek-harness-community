import type { GoalRef, IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { GoalPort } from '../../modules/task/contracts.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import { harnessValue } from './result.ts'

export interface ActiveSessionSource {
  readonly current: Readonly<RuntimeSessionSnapshot>
}

/** Harness adapter for the Task module's consumer-owned Goal port. */
export class HarnessGoalPort implements GoalPort {
  constructor(
    private readonly api: IApiClient,
    private readonly session: ActiveSessionSource,
  ) {}

  async create(objective: string, maxGoalRounds?: number): Promise<GoalRef> {
    return harnessValue(await this.api.goals.create({
      sessionId: this.requireSession(),
      objective,
      ...maxGoalRounds === undefined ? {} : { maxGoalRounds },
    })).ref
  }

  async edit(ref: GoalRef, objective?: string, maxGoalRounds?: number): Promise<GoalRef> {
    return harnessValue(await this.api.goals.edit({
      sessionId: this.requireSession(),
      ref,
      ...objective === undefined ? {} : { objective },
      ...maxGoalRounds === undefined ? {} : { maxGoalRounds },
    })).ref
  }

  async pause(ref: GoalRef): Promise<GoalRef> {
    return harnessValue(await this.api.goals.pause({ sessionId: this.requireSession(), ref })).ref
  }

  async resume(ref: GoalRef): Promise<GoalRef> {
    return harnessValue(await this.api.goals.resume({ sessionId: this.requireSession(), ref })).ref
  }

  async complete(ref: GoalRef): Promise<GoalRef> {
    return harnessValue(await this.api.goals.complete({ sessionId: this.requireSession(), ref })).ref
  }

  async clear(ref: GoalRef): Promise<void> {
    harnessValue(await this.api.goals.clear({ sessionId: this.requireSession(), ref }))
  }

  private requireSession(): NonNullable<RuntimeSessionSnapshot['sessionId']> {
    const sessionId = this.session.current.sessionId
    if (sessionId === undefined) throw new Error('no terminal session is active')
    return sessionId
  }
}
