import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import { appendedHistoryEntries } from '../../src/runtime/event-window.ts'

function entry(seq: number): HistoryEntry {
  return {
    event: {
      type: 'turn/start',
      seq,
      time: seq,
      data: { turn: seq },
    },
  }
}

describe('appendedHistoryEntries', () => {
  it('returns only the suffix for an append-only event window', () => {
    const first = entry(1)
    const second = entry(2)
    const previous = [first]
    const next = [first, second]

    expect(appendedHistoryEntries(previous, previous)).toEqual([])
    expect(appendedHistoryEntries(previous, next)).toEqual([second])
  })

  it('rejects replaced, shortened, and prepended event windows', () => {
    const first = entry(1)
    const second = entry(2)

    expect(appendedHistoryEntries([first], [entry(1)])).toBeUndefined()
    expect(appendedHistoryEntries([first, second], [first])).toBeUndefined()
    expect(appendedHistoryEntries([first], [second, first])).toBeUndefined()
  })
})
