import { describe, expect, it } from 'vitest'
import {
  groupTranscriptActivity,
  type TranscriptDiffItem,
  type TranscriptTextItem,
  type TranscriptThinkingItem,
  type TranscriptToolItem,
  type UngroupedTranscriptItem,
} from '../../../src/modules/transcript/model.ts'
import type { ExecutionNode } from '../../../src/runtime/execution/projection/index.ts'

function thinking(
  key: string,
  startedAt: number,
  endedAt: number,
): TranscriptThinkingItem {
  return {
    kind: 'thinking',
    key,
    text: key,
    execution: execution(key, 'thought', startedAt, endedAt),
  }
}

function tool(
  key: string,
  startedAt: number,
  endedAt: number,
): TranscriptToolItem {
  return {
    kind: 'tool',
    key,
    operation: key,
    execution: execution(key, 'tool', startedAt, endedAt),
  }
}

function execution(
  key: string,
  kind: ExecutionNode['kind'],
  startedAt: number,
  endedAt: number,
): ExecutionNode {
  return {
    key: key as ExecutionNode['key'],
    kind,
    durability: 'durable',
    state: {
      phase: 'settled', outcome: 'completed',
      started: { time: startedAt, source: 'event' },
      ended: { time: endedAt, source: 'event' },
    },
  }
}

const text: TranscriptTextItem = { kind: 'text', key: 'answer', body: 'visible answer' }
const diff: TranscriptDiffItem = {
  kind: 'diff',
  key: 'edit:diff',
  title: 'Edit src/app.ts',
  execution: execution('tool:edit', 'tool', 1, 2),
  diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }],
}

describe('groupTranscriptActivity', () => {
  it('keeps the group identity stable while its live tail grows', () => {
    const initial: UngroupedTranscriptItem[] = [
      thinking('thought:1:1', 1_000, 1_200),
      tool('tool:read', 1_250, 1_500),
    ]
    const first = groupTranscriptActivity(initial)
    const extended = groupTranscriptActivity([...initial, tool('tool:test', 1_600, 2_000)])

    expect(first).toEqual([expect.objectContaining({
      kind: 'activity',
      key: 'activity:thought:1:1',
      items: initial,
    })])
    expect(extended[0]?.key).toBe(first[0]?.key)
  })

  it('keeps diffs and visible text as ordered hard boundaries', () => {
    const grouped = groupTranscriptActivity([
      thinking('thought:before', 1, 2),
      tool('tool:before', 2, 3),
      diff,
      tool('tool:after', 4, 5),
      text,
      thinking('thought:final', 6, 7),
    ])

    expect(grouped.map(item => item.kind === 'activity' ? item.items.map(child => child.key) : item.key)).toEqual([
      ['thought:before', 'tool:before'], 'edit:diff', ['tool:after'], 'answer', ['thought:final'],
    ])
  })
})
