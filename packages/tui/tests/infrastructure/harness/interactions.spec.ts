import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessInteractionSource } from '../../../src/infrastructure/harness/interactions.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('HarnessInteractionSource', () => {
  it('claims the Host approval waterfall through the local handler', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const approval = vi.fn(async () => 'allowed-once' as const)
    new HarnessInteractionSource(ctx).connect({ approval, questions: async () => undefined })
    const agent = { id: SessionId('interaction') } as Agent
    const approvalFallback = vi.fn(async () => 'unavailable' as ApprovalOutcome)

    await expect(ctx.waterfall('approval/request', {
      agent,
      toolName: 'write_file',
      reason: 'changes workspace files',
    }, approvalFallback)).resolves.toBe('allowed-once')

    expect(approvalFallback).not.toHaveBeenCalled()
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: agent.id,
      toolName: 'write_file',
      reason: 'changes workspace files',
      requestId: expect.any(String),
    }))
  })

})
