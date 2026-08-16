import { describe, expect, it } from 'vitest'
import type { HistoryEntry, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiState } from '../../src/runtime/controller.ts'
import {
  buildTranscriptItems,
  groupTranscriptActivity,
  type TranscriptDiffItem,
  type TranscriptTextItem,
  type TranscriptThinkingItem,
  type TranscriptToolItem,
  type UngroupedTranscriptItem,
} from '../../src/presentation/transcript-model.ts'

function state(events: HistoryEntry[], running = false): TuiState {
  return {
    sessionId: 'session-test' as SessionSummary['sessionId'],
    cwd: '/workspace',
    running,
    connected: true,
    events,
    historyHasMore: false,
    queue: [],
    pendingSubmissions: [],
    models: undefined,
    projections: {},
    notice: undefined,
    error: undefined,
  }
}

function entry(value: unknown): HistoryEntry {
  return value as HistoryEntry
}

function thinking(
  key: string,
  status: TranscriptThinkingItem['status'],
  startedAt: number,
  endedAt?: number,
): TranscriptThinkingItem {
  return {
    kind: 'thinking',
    key,
    text: key,
    status,
    startedAt,
    ...endedAt === undefined ? {} : { endedAt },
  }
}

function tool(
  key: string,
  status: TranscriptToolItem['status'],
  startedAt: number,
  endedAt?: number,
): TranscriptToolItem {
  return {
    kind: 'tool',
    key,
    title: key,
    status,
    startedAt,
    ...endedAt === undefined ? {} : { endedAt },
  }
}

const text: TranscriptTextItem = { kind: 'text', body: 'visible answer' }
const diff: TranscriptDiffItem = {
  kind: 'diff',
  key: 'edit:diff',
  title: 'Edit src/app.ts',
  status: 'completed',
  diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }],
}

describe('groupTranscriptActivity', () => {
  it('keeps the group identity stable while its live tail grows', () => {
    const initial: UngroupedTranscriptItem[] = [
      thinking('1:1:thinking', 'completed', 1_000, 1_200),
      tool('read:tool', 'completed', 1_250, 1_500),
    ]
    const first = groupTranscriptActivity(initial, false)
    const extended = groupTranscriptActivity([...initial, tool('test:tool', 'completed', 1_600, 2_000)], false)

    expect(first).toEqual([expect.objectContaining({
      kind: 'activity',
      key: 'activity:1:1:thinking',
      status: 'completed',
      startedAt: 1_000,
      endedAt: 1_500,
      items: initial,
    })])
    expect(extended[0]).toMatchObject({ key: 'activity:1:1:thinking', status: 'completed' })
  })

  it('keeps diffs and visible text as ordered hard boundaries', () => {
    const grouped = groupTranscriptActivity([
      thinking('before:thinking', 'completed', 1, 2),
      tool('before:tool', 'completed', 2, 3),
      diff,
      tool('after:tool', 'completed', 4, 5),
      text,
      thinking('final:thinking', 'completed', 6, 7),
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
    expect(grouped[2]).not.toHaveProperty('endedAt')
  })

  it('preserves running, failed, and interrupted terminal states', () => {
    const streaming = groupTranscriptActivity([thinking('live:thinking', 'running', 1)], false)
    const failed = groupTranscriptActivity([
      tool('read:tool', 'completed', 1, 2),
      tool('test:tool', 'failed', 3, 5),
    ], true)
    const interrupted = groupTranscriptActivity([
      thinking('limited:thinking', 'interrupted', 6, 9),
    ], false)

    expect(streaming[0]).toMatchObject({ kind: 'activity', status: 'running' })
    expect(failed[0]).toMatchObject({ kind: 'activity', status: 'failed', startedAt: 1, endedAt: 5 })
    expect(interrupted[0]).toMatchObject({ kind: 'activity', status: 'interrupted', startedAt: 6, endedAt: 9 })
  })
})

describe('buildTranscriptItems', () => {
  it('completes streaming thinking when answer text starts in the same step', () => {
    const items = buildTranscriptItems(state([
      entry({
        event: {
          type: 'assistant/chunk',
          seq: 0,
          time: 1_000,
          data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning' } },
        },
      }),
      entry({
        event: {
          type: 'assistant/chunk',
          seq: 1,
          time: 1_250,
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'streaming answer' } },
        },
      }),
    ], true), true, false, 8)

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'activity',
        status: 'completed',
        startedAt: 1_000,
        endedAt: 1_250,
        items: [expect.objectContaining({
          kind: 'thinking',
          status: 'completed',
          startedAt: 1_000,
          endedAt: 1_250,
        })],
      }),
      { kind: 'text', body: 'streaming answer', markdown: true },
    ])
  })
})
