import { describe, expect, it, vi } from 'vitest'
import { RewindTransaction, type RewindPlan, type RewindPort } from '../../src/rewind/index.ts'

function plan(): RewindPlan {
  return {
    planId: 'plan',
    pointId: 'point',
    sessionId: 'session',
    turn: 2,
    input: { text: 'fix it again', attachments: [] },
    createdAt: 1,
    codeScope: 'backward',
    state: 'safe',
    files: [],
    participants: [],
  }
}

function rewindPort(overrides: Partial<RewindPort> = {}): RewindPort {
  return {
    activate: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    list: vi.fn(() => []),
    plan: vi.fn(async () => plan()),
    restore: vi.fn(async () => async () => {}),
    commit: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('RewindTransaction', () => {
  it('settles participants before listing points', async () => {
    const rewind = rewindPort({ list: vi.fn(() => []) })
    const transaction = new RewindTransaction(rewind, { rewind: vi.fn(async () => 'forked') })

    await transaction.list('session', '/workspace')

    expect(rewind.activate).toHaveBeenCalledWith('session', '/workspace')
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

    await expect(transaction.execute(selected, 'code-and-conversation')).resolves.toBe('forked-session')

    expect(rewind.restore).toHaveBeenCalledWith(selected)
    expect(conversation.rewind).toHaveBeenCalledWith(selected, expect.any(Function))
    expect(rewind.commit).toHaveBeenCalledWith(selected, 'code-and-conversation', 'forked-session')
  })

  it('compensates reversible state when the conversation commit fails', async () => {
    const rollback = vi.fn(async () => {})
    const rewind = rewindPort({ restore: vi.fn(async () => rollback) })
    const transaction = new RewindTransaction(rewind, {
      rewind: vi.fn(async () => { throw new Error('fork failed') }),
    })
    const phases: string[] = []

    await expect(transaction.execute(plan(), 'code-and-conversation', phase => { phases.push(phase) })).rejects.toThrow('fork failed')

    expect(rollback).toHaveBeenCalledOnce()
    expect(rewind.commit).not.toHaveBeenCalled()
    expect(phases).toContain('compensating')
  })

  it('can restore only conversation without applying reversible effects', async () => {
    const rewind = rewindPort()
    const conversation = { rewind: vi.fn(async () => 'forked-session') }
    const transaction = new RewindTransaction(rewind, conversation)
    const selected = plan()

    await expect(transaction.execute(selected, 'conversation-only')).resolves.toBe('forked-session')

    expect(rewind.restore).not.toHaveBeenCalled()
    expect(conversation.rewind).toHaveBeenCalledOnce()
    expect(rewind.commit).toHaveBeenCalledWith(selected, 'conversation-only', 'forked-session')
  })

  it('can restore only code without forking or replacing the conversation', async () => {
    const rewind = rewindPort()
    const conversation = { rewind: vi.fn(async () => 'forked-session') }
    const transaction = new RewindTransaction(rewind, conversation)
    const selected = plan()

    await expect(transaction.execute(selected, 'code-only')).resolves.toBe('session')

    expect(rewind.restore).toHaveBeenCalledWith(selected)
    expect(conversation.rewind).not.toHaveBeenCalled()
    expect(rewind.commit).toHaveBeenCalledWith(selected, 'code-only', undefined)
  })
})
