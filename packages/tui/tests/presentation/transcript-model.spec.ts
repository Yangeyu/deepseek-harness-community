import { describe, expect, it } from 'vitest'
import type { HistoryEntry, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiState } from '../../src/runtime/controller.ts'
import {
  appendTranscriptChunks,
  buildTranscriptItems,
  groupTranscriptActivity,
  type TranscriptDiffItem,
  type TranscriptTextItem,
  type TranscriptThinkingItem,
  type TranscriptToolItem,
  type UngroupedTranscriptItem,
} from '../../src/presentation/transcript-model.ts'
import {
  buildLifecycleSnapshot,
  executionStatus,
  type ExecutionStatus,
  type LifecycleNode,
} from '../../src/runtime/lifecycle/index.ts'

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
    lifecycle: buildLifecycleSnapshot({
      sessionId: 'session-test',
      generation: 0,
      entries: events,
      sessionRunning: running,
    }),
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
  status: ExecutionStatus,
  startedAt: number,
  endedAt?: number,
): TranscriptThinkingItem {
  return {
    kind: 'thinking',
    key,
    text: key,
    lifecycle: lifecycle(key, 'thought', status, startedAt, endedAt),
  }
}

function tool(
  key: string,
  status: ExecutionStatus,
  startedAt: number,
  endedAt?: number,
): TranscriptToolItem {
  return {
    kind: 'tool',
    key,
    title: key,
    lifecycle: lifecycle(key, 'tool', status, startedAt, endedAt),
  }
}

function lifecycle(
  key: string,
  kind: LifecycleNode['kind'],
  status: ExecutionStatus,
  startedAt: number,
  endedAt?: number,
): LifecycleNode {
  return {
    key: key as LifecycleNode['key'],
    kind,
    durability: 'durable',
    state: status === 'pending'
      ? { phase: 'pending', declared: { time: startedAt, source: 'event' } }
      : status === 'running'
        ? { phase: 'running', started: { time: startedAt, source: 'event' } }
        : {
            phase: 'settled',
            outcome: status,
            started: { time: startedAt, source: 'event' },
            ended: { ...endedAt === undefined ? {} : { time: endedAt }, source: 'event' },
          },
  }
}

const text: TranscriptTextItem = { kind: 'text', key: 'answer', body: 'visible answer' }
const diff: TranscriptDiffItem = {
  kind: 'diff',
  key: 'edit:diff',
  title: 'Edit src/app.ts',
  lifecycle: lifecycle('tool:edit', 'tool', 'completed', 1, 2),
  diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }],
}

describe('groupTranscriptActivity', () => {
  it('keeps the group identity stable while its live tail grows', () => {
    const initial: UngroupedTranscriptItem[] = [
      thinking('thought:1:1', 'completed', 1_000, 1_200),
      tool('tool:read', 'completed', 1_250, 1_500),
    ]
    const first = groupTranscriptActivity(initial)
    const extended = groupTranscriptActivity([...initial, tool('tool:test', 'completed', 1_600, 2_000)])

    expect(first).toEqual([expect.objectContaining({
      kind: 'activity',
      key: 'activity:thought:1:1',
      lifecycle: { status: 'completed', startedAt: 1_000, endedAt: 1_500 },
      items: initial,
    })])
    expect(extended[0]).toMatchObject({
      key: 'activity:thought:1:1',
      lifecycle: { status: 'completed' },
    })
  })

  it('keeps diffs and visible text as ordered hard boundaries', () => {
    const grouped = groupTranscriptActivity([
      thinking('thought:before', 'completed', 1, 2),
      tool('tool:before', 'completed', 2, 3),
      diff,
      tool('tool:after', 'completed', 4, 5),
      text,
      thinking('thought:final', 'completed', 6, 7),
    ])

    expect(grouped.map(item => item.kind)).toEqual(['activity', 'diff', 'activity', 'text', 'activity'])
    expect(grouped[1]).toBe(diff)
    expect(grouped[3]).toBe(text)
  })

  it('does not let session liveness override settled child nodes', () => {
    const grouped = groupTranscriptActivity([
      tool('tool:before', 'completed', 1, 2),
      text,
      tool('tool:tail', 'completed', 3, 4),
    ])

    expect(grouped[0]).toMatchObject({ kind: 'activity', lifecycle: { status: 'completed' } })
    expect(grouped[2]).toMatchObject({ kind: 'activity', lifecycle: { status: 'completed' } })
  })

  it('preserves running, failed, and interrupted terminal states', () => {
    const streaming = groupTranscriptActivity([thinking('thought:live', 'running', 1)])
    const failed = groupTranscriptActivity([
      tool('tool:read', 'completed', 1, 2),
      tool('tool:test', 'failed', 3, 5),
    ])
    const interrupted = groupTranscriptActivity([
      thinking('thought:limited', 'interrupted', 6, 9),
    ])

    expect(streaming[0]).toMatchObject({ kind: 'activity', lifecycle: { status: 'running' } })
    expect(failed[0]).toMatchObject({
      kind: 'activity',
      lifecycle: { status: 'failed', startedAt: 1, endedAt: 5 },
    })
    expect(interrupted[0]).toMatchObject({
      kind: 'activity',
      lifecycle: { status: 'interrupted', startedAt: 6, endedAt: 9 },
    })
  })
})

describe('buildTranscriptItems', () => {
  it('increments the streaming tail with full-rebuild parity', () => {
    const first = entry({
      event: {
        type: 'assistant/chunk',
        seq: 0,
        time: 1,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'one' } },
      },
    })
    const second = entry({
      event: {
        type: 'assistant/chunk',
        seq: 1,
        time: 2,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: ' two' } },
      },
    })
    const answer = entry({
      event: {
        type: 'assistant/chunk',
        seq: 2,
        time: 3,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'answer' } },
      },
    })
    const initialState = state([first], true)
    const initial = buildTranscriptItems(initialState, true, false, 8)
    const reasoningState = state([first, second], true)
    const reasoning = appendTranscriptChunks(initial, [second], reasoningState.lifecycle, true)
    expect(reasoning).toEqual(buildTranscriptItems(reasoningState, true, false, 8))

    const answerState = state([first, second, answer], true)
    const answered = appendTranscriptChunks(reasoning!, [answer], answerState.lifecycle, true)
    expect(answered).toEqual(buildTranscriptItems(answerState, true, false, 8))

    const hiddenInitial = buildTranscriptItems(initialState, false, false, 8)
    const hiddenReasoning = appendTranscriptChunks(hiddenInitial, [second], reasoningState.lifecycle, false)
    expect(hiddenReasoning).toEqual(buildTranscriptItems(reasoningState, false, false, 8))
    const hiddenAnswer = appendTranscriptChunks(hiddenReasoning!, [answer], answerState.lifecycle, false)
    expect(hiddenAnswer).toEqual(buildTranscriptItems(answerState, false, false, 8))
  })

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
        lifecycle: { status: 'completed', startedAt: 1_000, endedAt: 1_250 },
        items: [expect.objectContaining({
          kind: 'thinking',
          lifecycle: expect.any(Object),
        })],
      }),
      { kind: 'text', key: 'assistant:1:1:text', body: 'streaming answer', markdown: true },
    ])
    const activity = items[0]
    expect(activity?.kind === 'activity'
      ? executionStatus(activity.items[0]!.lifecycle)
      : undefined).toBe('completed')
  })
})
