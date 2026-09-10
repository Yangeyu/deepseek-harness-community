import { describe, expect, it } from 'vitest'
import type { HistoryEntry, SessionSummary } from '../../../src/runtime/session/contracts.ts'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/manager.ts'
import {
  buildTranscriptItems,
  groupTranscriptActivity,
  type TranscriptDiffItem,
  type TranscriptTextItem,
  type TranscriptThinkingItem,
  type TranscriptToolItem,
  type UngroupedTranscriptItem,
} from '../../../src/modules/transcript/model.ts'
import {
  buildExecutionSnapshot,
  executionStatus,
  type ExecutionStatus,
  type ExecutionNode,
} from '../../../src/runtime/execution/projection/index.ts'

function state(events: HistoryEntry[], running = false): RuntimeSessionSnapshot {
  return {
    binding: { phase: 'active', sessionId: 'session-test' as SessionSummary['sessionId'], epoch: 0 },
    sessionId: 'session-test' as SessionSummary['sessionId'],
    cwd: '/workspace',
    runState: running ? 'running' : 'idle',
    connection: { events: 'online', control: 'online' },
    events,
    historyHasMore: false,
    queue: [],
    pendingSubmissions: [],
    execution: buildExecutionSnapshot({
      sessionId: 'session-test',
      epoch: 0,
      entries: events,
      sessionRunning: running,
    }),
    modelCatalog: undefined,
    projections: {},
    notice: undefined,
    error: undefined,
  }
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
    execution: execution(key, 'thought', status, startedAt, endedAt),
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
    toolName: key,
    operation: key,
    execution: execution(key, 'tool', status, startedAt, endedAt),
  }
}

function execution(
  key: string,
  kind: ExecutionNode['kind'],
  status: ExecutionStatus,
  startedAt: number,
  endedAt?: number,
): ExecutionNode {
  return {
    key: key as ExecutionNode['key'],
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
  execution: execution('tool:edit', 'tool', 'completed', 1, 2),
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
      execution: { status: 'completed', startedAt: 1_000, endedAt: 1_500 },
      items: initial,
    })])
    expect(extended[0]).toMatchObject({
      key: 'activity:thought:1:1',
      execution: { status: 'completed' },
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

    expect(grouped[0]).toMatchObject({ kind: 'activity', execution: { status: 'completed' } })
    expect(grouped[2]).toMatchObject({ kind: 'activity', execution: { status: 'completed' } })
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

    expect(streaming[0]).toMatchObject({ kind: 'activity', execution: { status: 'running' } })
    expect(failed[0]).toMatchObject({
      kind: 'activity',
      execution: { status: 'failed', startedAt: 1, endedAt: 5 },
    })
    expect(interrupted[0]).toMatchObject({
      kind: 'activity',
      execution: { status: 'interrupted', startedAt: 6, endedAt: 9 },
    })
  })
})

describe('buildTranscriptItems', () => {
  it('completes streaming thinking when answer text starts in the same step', () => {
    const assistant = {
      turn: 1, step: 1, reasoningStartedAt: 1_000, reasoningEndedAt: 1_250,
      content: [{ type: 'reasoning' as const, text: 'reasoning' }, { type: 'text' as const, text: 'streaming answer' }],
    }
    const live = state([], true)
    const items = buildTranscriptItems({ ...live, assistant, execution: buildExecutionSnapshot({
      sessionId: 'session-test', epoch: 0, entries: [], sessionRunning: true, assistant,
    }) }, true, false, 8)

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'activity',
        execution: { status: 'completed', startedAt: 1_000, endedAt: 1_250 },
        items: [expect.objectContaining({
          kind: 'thinking',
          execution: expect.any(Object),
        })],
      }),
      { kind: 'text', key: 'assistant:1:1:text', body: 'streaming answer', markdown: true },
    ])
    const activity = items[0]
    expect(activity?.kind === 'activity'
      ? executionStatus(activity.items[0]!.execution)
      : undefined).toBe('completed')
  })
})
