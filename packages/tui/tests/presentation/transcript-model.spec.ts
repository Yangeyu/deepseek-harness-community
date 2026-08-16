import { describe, expect, it } from 'vitest'
import {
  groupTranscriptActivity,
  type TranscriptDiffItem,
  type TranscriptTextItem,
  type TranscriptThinkingItem,
  type TranscriptToolItem,
  type UngroupedTranscriptItem,
} from '../../src/presentation/transcript-model.ts'

function thinking(key: string, startedAt: number, completedAt?: number): TranscriptThinkingItem {
  return {
    kind: 'thinking',
    key,
    text: key,
    streaming: completedAt === undefined,
    startedAt,
    ...completedAt === undefined ? {} : { completedAt },
  }
}

function tool(
  key: string,
  status: TranscriptToolItem['status'],
  startedAt: number,
  completedAt?: number,
): TranscriptToolItem {
  return {
    kind: 'tool',
    key,
    title: key,
    status,
    startedAt,
    ...completedAt === undefined ? {} : { completedAt },
  }
}

const text: TranscriptTextItem = { kind: 'text', body: 'visible answer' }
const diff: TranscriptDiffItem = {
  kind: 'diff',
  key: 'edit:diff',
  title: 'Edit src/app.ts',
  settled: true,
  diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }],
}

describe('groupTranscriptActivity', () => {
  it('folds adjacent thinking and tools into one stable activity group', () => {
    const initial: UngroupedTranscriptItem[] = [
      thinking('1:1:thinking', 1_000, 1_200),
      tool('read:tool', 'completed', 1_250, 1_500),
    ]
    const first = groupTranscriptActivity(initial, false)
    const extended = groupTranscriptActivity([...initial, tool('test:tool', 'completed', 1_600, 2_000)], false)

    expect(first).toEqual([expect.objectContaining({
      kind: 'activity',
      key: 'activity:1:1:thinking',
      status: 'completed',
      startedAt: 1_000,
      completedAt: 1_500,
      items: initial,
    })])
    expect(extended[0]).toMatchObject({ key: 'activity:1:1:thinking', status: 'completed' })
  })

  it('keeps diffs and visible text as ordered hard boundaries', () => {
    const grouped = groupTranscriptActivity([
      thinking('before:thinking', 1, 2),
      tool('before:tool', 'completed', 2, 3),
      diff,
      tool('after:tool', 'completed', 4, 5),
      text,
      thinking('final:thinking', 6, 7),
    ], false)

    expect(grouped.map(item => item.kind)).toEqual(['activity', 'diff', 'activity', 'text', 'activity'])
    expect(grouped[1]).toBe(diff)
    expect(grouped[3]).toBe(text)
  })

  it('marks only the trailing activity as live while the session is running', () => {
    const grouped = groupTranscriptActivity([
      tool('before:tool', 'completed', 1, 2),
      text,
      tool('tail:tool', 'completed', 3, 4),
    ], true)

    expect(grouped[0]).toMatchObject({ kind: 'activity', status: 'completed' })
    expect(grouped[2]).toMatchObject({ kind: 'activity', status: 'running' })
    expect(grouped[2]).not.toHaveProperty('completedAt')
  })

  it('keeps streaming and failed states visible without relying on session state', () => {
    const streaming = groupTranscriptActivity([thinking('live:thinking', 1)], false)
    const failed = groupTranscriptActivity([
      tool('read:tool', 'completed', 1, 2),
      tool('test:tool', 'failed', 3, 5),
    ], true)

    expect(streaming[0]).toMatchObject({ kind: 'activity', status: 'running' })
    expect(failed[0]).toMatchObject({ kind: 'activity', status: 'failed', startedAt: 1, completedAt: 5 })
  })
})
