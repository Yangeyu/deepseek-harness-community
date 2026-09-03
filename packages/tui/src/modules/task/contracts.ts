import type { GoalRef } from '@deepseek-ai/dsh-host-apiproxy'

/** Goal operations consumed by the Task feature. */
export interface GoalPort {
  create(objective: string, maxGoalRounds?: number): Promise<GoalRef>
  edit(ref: GoalRef, objective?: string, maxGoalRounds?: number): Promise<GoalRef>
  pause(ref: GoalRef): Promise<GoalRef>
  resume(ref: GoalRef): Promise<GoalRef>
  complete(ref: GoalRef): Promise<GoalRef>
  clear(ref: GoalRef): Promise<void>
}
