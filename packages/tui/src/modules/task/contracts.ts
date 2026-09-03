import type { GoalRef } from '@deepseek-ai/dsh-goal/types'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'

export interface GoalSessionSource {
  readonly current: Readonly<RuntimeSessionSnapshot>
}

/** Goal operations consumed by the Task feature. */
export interface GoalPort {
  create(objective: string, maxGoalRounds?: number): Promise<GoalRef>
  edit(ref: GoalRef, objective?: string, maxGoalRounds?: number): Promise<GoalRef>
  pause(ref: GoalRef): Promise<GoalRef>
  resume(ref: GoalRef): Promise<GoalRef>
  complete(ref: GoalRef): Promise<GoalRef>
  clear(ref: GoalRef): Promise<void>
}
