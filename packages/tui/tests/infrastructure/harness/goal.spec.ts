import { describe, expect, it, vi } from 'vitest'
import type { GoalRef, IApiClient, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { HarnessGoalPort } from '../../../src/infrastructure/harness/goal.ts'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/snapshot.ts'

const rpcId = 'rpc-test' as RpcId

describe('HarnessGoalPort', () => {
  it('routes Goal mutations through structured CAS RPCs', async () => {
    const nextRef = { id: 'goal-next', revision: 4 } as GoalRef
    const create = vi.fn(async () => ({ rpcId, result: { ok: true as const, value: { ref: nextRef } } }))
    const edit = vi.fn(async () => ({ rpcId, result: { ok: true as const, value: { ref: nextRef } } }))
    const api = {
      goals: {
        create,
        edit,
        pause: async () => ({ rpcId, result: { ok: true as const, value: { ref: nextRef } } }),
        resume: async () => ({ rpcId, result: { ok: true as const, value: { ref: nextRef } } }),
        complete: async () => ({ rpcId, result: { ok: true as const, value: { ref: nextRef } } }),
        clear: async () => ({ rpcId, result: { ok: true as const, value: { cleared: true as const } } }),
      },
    } as unknown as IApiClient
    const session = { current: { sessionId: 'session-test' } as RuntimeSessionSnapshot }
    const goals = new HarnessGoalPort(api, session)

    const created = await goals.create('Ship it', 8)
    await goals.edit(created, 'Ship safely', 10)

    expect(create).toHaveBeenCalledWith({
      sessionId: 'session-test',
      objective: 'Ship it',
      maxGoalRounds: 8,
    })
    expect(edit).toHaveBeenCalledWith({
      sessionId: 'session-test',
      ref: nextRef,
      objective: 'Ship safely',
      maxGoalRounds: 10,
    })
  })
})
