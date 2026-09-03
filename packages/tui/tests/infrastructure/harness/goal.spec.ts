import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal/types'
import { describe, expect, it, vi } from 'vitest'
import { HarnessGoalPort } from '../../../src/infrastructure/harness/goal.ts'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/snapshot.ts'

const agent = {} as Agent
const next: GoalView = {
  id: 'goal-next' as GoalView['id'],
  revision: 4,
  objective: 'Ship it',
  phase: 'active',
  maxGoalRounds: 8,
  roundsStarted: 1,
  createdAt: 1,
  updatedAt: 2,
  activation: 'armed',
}

function fixture() {
  const resolveAgent = vi.fn(async () => ({ agent }))
  const goals = {
    create: vi.fn(() => next),
    edit: vi.fn(() => next),
    pause: vi.fn(() => next),
    resume: vi.fn(() => next),
    complete: vi.fn(() => next),
    clear: vi.fn((_: Agent, ref: GoalRef) => ({ ...ref, revision: ref.revision + 1 })),
  }
  const session = {
    current: { sessionId: 'session-test' as RuntimeSessionSnapshot['sessionId'] },
  }
  const port = new HarnessGoalPort(
    { resolveAgent } as unknown as ConstructorParameters<typeof HarnessGoalPort>[0],
    goals as unknown as ConstructorParameters<typeof HarnessGoalPort>[1],
    session as ConstructorParameters<typeof HarnessGoalPort>[2],
  )
  return { port, resolveAgent, goals }
}

describe('HarnessGoalPort', () => {
  it('resolves the active Agent and invokes the Goal domain directly', async () => {
    const { port, resolveAgent, goals } = fixture()
    const ref = { id: next.id, revision: 3 }

    await expect(port.create('Ship it', 8)).resolves.toEqual(next)
    await expect(port.edit(ref, 'Ship it better', 10)).resolves.toEqual(next)
    await expect(port.pause(ref)).resolves.toEqual(next)
    await expect(port.resume(ref)).resolves.toEqual(next)
    await expect(port.complete(ref)).resolves.toEqual(next)
    await expect(port.clear(ref)).resolves.toBeUndefined()

    expect(resolveAgent).toHaveBeenCalledTimes(6)
    expect(goals.create).toHaveBeenCalledWith(agent, { objective: 'Ship it', maxGoalRounds: 8 })
    expect(goals.edit).toHaveBeenCalledWith(agent, ref, { objective: 'Ship it better', maxGoalRounds: 10 })
    expect(goals.clear).toHaveBeenCalledWith(agent, ref)
  })

  it('surfaces Session resolution failure without invoking the Goal domain', async () => {
    const { port, resolveAgent, goals } = fixture()
    resolveAgent.mockResolvedValueOnce({ error: { message: 'session unavailable' } } as never)

    await expect(port.create('Ship it')).rejects.toThrow('session unavailable')
    expect(goals.create).not.toHaveBeenCalled()
  })
})
