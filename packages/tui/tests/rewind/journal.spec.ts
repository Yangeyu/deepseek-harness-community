import { describe, expect, it } from 'vitest'
import { RewindJournal } from '../../src/rewind/domain/journal.ts'

function journal(history = 2): RewindJournal {
  return new RewindJournal({ history, maxMutationBytes: 100, maxSessionBytes: 200 })
}

describe('RewindJournal', () => {
  it('retains bounded turn history and returns evicted participant references', () => {
    const history = journal()
    history.beginTurn({ sessionId: 'session', turn: 1, workspaceRoot: '/workspace', prompt: 'one' })
    history.recordEffect({ participantId: 'memory', effectId: 'effect-1', sourceSessionId: 'session', sourceTurn: 1 })
    history.beginTurn({ sessionId: 'session', turn: 2, workspaceRoot: '/workspace', prompt: 'two' })
    const released = history.beginTurn({ sessionId: 'session', turn: 3, workspaceRoot: '/workspace', prompt: 'three' })

    expect(history.list('session').map(point => point.turn)).toEqual([2, 3])
    expect(released).toEqual([{
      participantId: 'memory',
      effectId: 'effect-1',
      sourceSessionId: 'session',
      sourceTurn: 1,
    }])
  })

  it('selects the boundary and every retained effect after it', () => {
    const history = journal(3)
    history.beginTurn({ sessionId: 'session', turn: 1, workspaceRoot: '/workspace', prompt: 'one' })
    history.beginTurn({ sessionId: 'session', turn: 2, workspaceRoot: '/workspace', prompt: 'two' })
    history.recordEffect({ participantId: 'memory', effectId: 'effect-2', sourceSessionId: 'session', sourceTurn: 2 })
    const points = history.list('session')

    const selected = history.select('session', points[0]?.id ?? '')

    expect(selected.point.turn).toBe(1)
    expect(selected.effects.map(effect => effect.effectId)).toEqual(['effect-2'])
  })
})
