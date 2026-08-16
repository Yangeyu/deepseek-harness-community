import { describe, expect, it, vi } from 'vitest'
import { RewindTransaction, type RewindPlan, type RewindPort } from '../../src/rewind/index.ts'

function plan(): RewindPlan {
  return {
    planId: 'plan',
    pointId: 'point',
    sessionId: 'session',
    turn: 2,
    prompt: 'fix it again',
    createdAt: 1,
    state: 'safe',
    files: [],
    participants: [],
  }
}

function rewindPort(overrides: Partial<RewindPort> = {}): RewindPort {
  return {
    settle: vi.fn(async () => {}),
    list: vi.fn(() => []),
    plan: vi.fn(async () => plan()),
    restore: vi.fn(async () => async () => {}),
    continueFrom: vi.fn(),
    ...overrides,
  }
}

describe('RewindTransaction', () => {
  it('settles participants before listing points', async () => {
    const rewind = rewindPort({ list: vi.fn(() => []) })
    const transaction = new RewindTransaction(rewind, { rewind: vi.fn(async () => 'forked') })

    await transaction.list('session')

    expect(rewind.settle).toHaveBeenCalledWith('session')
    expect(rewind.list).toHaveBeenCalledWith('session')
    expect(vi.mocked(rewind.settle).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(rewind.list).mock.invocationCallOrder[0] ?? 0)
  })

  it('commits the conversation after reversible state and advances the journal', async () => {
    const rewind = rewindPort()
    const conversation = { rewind: vi.fn(async () => 'forked-session') }
    const transaction = new RewindTransaction(rewind, conversation)
    const selected = plan()

    await expect(transaction.execute(selected)).resolves.toBe('forked-session')

    expect(rewind.restore).toHaveBeenCalledWith(selected)
    expect(conversation.rewind).toHaveBeenCalledWith(selected, expect.any(Function))
    expect(rewind.continueFrom).toHaveBeenCalledWith(selected, 'forked-session')
  })

  it('compensates reversible state when the conversation commit fails', async () => {
    const rollback = vi.fn(async () => {})
    const rewind = rewindPort({ restore: vi.fn(async () => rollback) })
    const transaction = new RewindTransaction(rewind, {
      rewind: vi.fn(async () => { throw new Error('fork failed') }),
    })
    const phases: string[] = []

    await expect(transaction.execute(plan(), phase => { phases.push(phase) })).rejects.toThrow('fork failed')

    expect(rollback).toHaveBeenCalledOnce()
    expect(rewind.continueFrom).not.toHaveBeenCalled()
    expect(phases).toContain('compensating')
  })
})
