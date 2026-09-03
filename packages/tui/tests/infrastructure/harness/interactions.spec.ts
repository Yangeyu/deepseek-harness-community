import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessInteractionSource } from '../../../src/infrastructure/harness/interactions.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('HarnessInteractionSource', () => {
  it('claims Host approval and question waterfalls through one local handler', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const approval = vi.fn(async () => 'allowed-once' as const)
    const questions = vi.fn(async () => ({ answers: [{ id: 'choice', selected: ['Yes'] }] }))
    new HarnessInteractionSource(ctx).connect({ approval, questions })
    const agent = { id: SessionId('interaction') } as Agent
    const approvalFallback = vi.fn(async () => 'unavailable' as ApprovalOutcome)
    const questionFallback = vi.fn(async () => ({ answers: [] }) as AskUserQuestionAnswer)

    await expect(ctx.waterfall('approval/request', {
      agent,
      toolName: 'write_file',
      reason: 'changes workspace files',
    }, approvalFallback)).resolves.toBe('allowed-once')
    await expect(ctx.waterfall('user-questions/request', {
      agent,
      questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }],
    }, questionFallback)).resolves.toEqual({ answers: [{ id: 'choice', selected: ['Yes'] }] })

    expect(approvalFallback).not.toHaveBeenCalled()
    expect(questionFallback).not.toHaveBeenCalled()
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: agent.id,
      toolName: 'write_file',
      reason: 'changes workspace files',
      requestId: expect.any(String),
    }))
    expect(questions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: agent.id,
      requestId: expect.any(String),
    }))
  })

})
