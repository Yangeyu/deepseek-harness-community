import type { MemoryMutation } from '@vascent/deepseek-harness-memory'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRewindParticipant } from '../../src/rewind/index.ts'

function mutation(id: string, turn: number): MemoryMutation {
  return {
    id,
    sourceSessionId: 'session',
    sourceTurn: turn,
    scope: 'project',
    summary: id,
    operation: 'write',
    files: [],
    createdAt: turn,
  }
}

describe('MemoryRewindParticipant', () => {
  it('keeps Memory payloads behind opaque effect identifiers', () => {
    const participant = new MemoryRewindParticipant({ settle: vi.fn(async () => {}), restore: vi.fn(async () => {}) })

    expect(participant.capture(mutation('memory-1', 2))).toEqual({
      participantId: 'memory',
      effectId: 'memory-1',
      sourceSessionId: 'session',
      sourceTurn: 2,
    })
  })

  it('reverts newest-first and compensates oldest-first', async () => {
    const calls: Array<[string, 'before' | 'after']> = []
    const restore = vi.fn(async (item: MemoryMutation, direction: 'before' | 'after') => {
      calls.push([item.id, direction])
    })
    const participant = new MemoryRewindParticipant({ settle: vi.fn(async () => {}), restore })
    participant.capture(mutation('first', 1))
    participant.capture(mutation('second', 2))
    const prepared = await participant.prepare(['first', 'second'])

    const compensate = await prepared.apply()
    expect(calls).toEqual([
      ['second', 'before'],
      ['first', 'before'],
    ])

    await compensate()
    expect(calls).toEqual([
      ['second', 'before'],
      ['first', 'before'],
      ['first', 'after'],
      ['second', 'after'],
    ])
  })

  it('blocks a plan whose attributed payload has been released', async () => {
    const participant = new MemoryRewindParticipant({ settle: vi.fn(async () => {}), restore: vi.fn(async () => {}) })
    participant.capture(mutation('memory-1', 1))
    participant.release(['memory-1'])

    const prepared = await participant.prepare(['memory-1'])

    expect(prepared.impact).toMatchObject({ state: 'conflict' })
    await expect(prepared.apply()).rejects.toThrow('incomplete')
  })

  it('reapplies already-reverted updates when a later Memory restore fails', async () => {
    const calls: Array<[string, 'before' | 'after']> = []
    const restore = vi.fn(async (item: MemoryMutation, direction: 'before' | 'after') => {
      calls.push([item.id, direction])
      if (item.id === 'first' && direction === 'before') throw new Error('stale memory')
    })
    const participant = new MemoryRewindParticipant({ settle: vi.fn(async () => {}), restore })
    participant.capture(mutation('first', 1))
    participant.capture(mutation('second', 2))
    const prepared = await participant.prepare(['first', 'second'])

    await expect(prepared.apply()).rejects.toThrow('stale memory')

    expect(calls).toEqual([
      ['second', 'before'],
      ['first', 'before'],
      ['second', 'after'],
    ])
  })
})
