import { describe, expect, it, vi } from 'vitest'
import { TranscriptModel } from '../../../src/modules/transcript/model.ts'
import type { QueuedInboxItem } from '../../../src/runtime/session/contracts.ts'
import { state, entry } from './fixtures.ts'

function call(seq: number, callId: string, path = '/project') {
  return entry({ event: {
    type: 'tool/call', seq, time: 1_000 + seq,
    data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ path }) },
  } })
}

function prompt(seq: number, text: string, rpcId?: string) {
  return entry({ event: {
    type: 'user/message', seq, time: seq, surfaceOp: 'append',
    data: { id: `prompt-${seq}`, source: { kind: 'user', ...rpcId === undefined ? {} : { rpcId } }, content: [{ type: 'text', text }] },
  } })
}

describe('TranscriptModel', () => {
  it('shows one prompt per identity with history before queue before local echo, not one per text', () => {
    const model = new TranscriptModel(true, 8)
    const snapshot = state([
      prompt(1, 'Repeat this', 'rpc-first'),
      prompt(2, 'Remote prompt'),
    ], true, [
      { key: 1, requestId: 'rpc-first' as never, text: 'stale first echo', intent: 'queueing' },
      { key: 2, requestId: 'rpc-second' as never, text: 'stale second echo', intent: 'queueing' },
      { key: 3, messageId: 'prompt-2', text: 'stale remote echo', intent: 'working' },
      { key: 4, requestId: 'rpc-local' as never, text: 'Still local', intent: 'working' },
    ])
    const projection = model.project({
      ...snapshot,
      queue: [
        {
          id: 'queued-first' as never, rpcId: 'rpc-first' as never, placement: 'queued',
          message: { id: 'queued-first' as never, content: [{ type: 'text', text: 'stale queued copy' }] },
        },
        {
          id: 'queued-second' as never, rpcId: 'rpc-second' as never, placement: 'queued',
          message: { id: 'queued-second' as never, content: [{ type: 'text', text: 'Repeat this' }] },
        },
        {
          id: 'prompt-2' as never, placement: 'queued',
          message: { id: 'prompt-2' as never, content: [{ type: 'text', text: 'stale remote queue' }] },
        },
      ],
    }, false)

    expect(projection.items.map(item => item.kind === 'prompt'
      ? { key: item.key, body: item.body, status: item.promptStatus }
      : { kind: item.kind })).toEqual([
      { key: 'prompt:rpc-first', body: 'Repeat this', status: undefined },
      { key: 'prompt:prompt-2', body: 'Remote prompt', status: undefined },
      { key: 'prompt:rpc-second', body: 'Repeat this', status: 'Queued' },
      { key: 'prompt:rpc-local', body: 'Still local', status: undefined },
    ])
  })

  it('keeps consumed input before waiting prompts and new local input throughout handoff', () => {
    const model = new TranscriptModel(true, 8)
    const queue = ['A', 'B'].map((body): QueuedInboxItem => ({
      id: `message-${body}` as never, rpcId: `rpc-${body}` as never, placement: 'queued',
      message: { id: `message-${body}` as never, content: [{ type: 'text', text: body }] },
    }))
    const local = { key: 1, requestId: 'rpc-C' as never, text: 'C', intent: 'queueing' } as const
    const consumed = {
      key: 2, requestId: 'rpc-A' as never, messageId: 'message-A', text: 'A', intent: 'working',
    } as const
    const base = state([], true, [local])
    const snapshots = [
      { ...base, queue },
      // A lagging combined snapshot still prefers the queue's body to its consumed echo.
      { ...base, queue, pendingSubmissions: [local, { ...consumed, text: 'stale A' }] },
      { ...base, queue: queue.slice(1), pendingSubmissions: [local, consumed] },
      { ...state([prompt(1, 'A', 'rpc-A')], true, [local]), queue: queue.slice(1) },
    ]

    for (const snapshot of snapshots) {
      const projection = model.project(snapshot, false)
      expect(projection.items.flatMap(item => item.kind === 'prompt' ? [{ key: item.key, body: item.body }] : []))
        .toEqual([
          { key: 'prompt:rpc-A', body: 'A' },
          { key: 'prompt:rpc-B', body: 'B' },
          { key: 'prompt:rpc-C', body: 'C' },
        ])
    }
  })

  it('keeps adjacent activity together and preserves its identity as tools arrive', () => {
    const model = new TranscriptModel(true, 8)
    const history = [entry({ event: {
      type: 'assistant/message', seq: 0, time: 1_000, surfaceOp: 'append',
      data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'reasoning', text: 'Inspecting' }] } },
    } }), call(1, 'read')]
    const first = model.project(state(history, true), false)
    const extended = model.project(state([...history, call(2, 'test')], true), false)

    expect(extended.items).toMatchObject([{
      kind: 'activity', key: first.items[0]!.key,
      items: [{ kind: 'thinking' }, { key: 'tool:read' }, { key: 'tool:test' }],
    }])
    expect(extended.activeActivityKey).toBe(first.activeActivityKey)
  })

  it('uses formal prompts, body text and diffs as ordered activity boundaries', () => {
    const model = new TranscriptModel(true, 8)
    const edit = entry({ ...call(1, 'edit'), view: { for: 'call', view: {
      card: 'diff', title: 'Edit src/app.ts', diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }],
    } } })
    const projection = model.project(state([
      call(0, 'before'), edit, call(2, 'after'),
      entry({ event: { type: 'assistant/message', seq: 3, time: 1_003, surfaceOp: 'append', data: {
        turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: 'Answer' }] },
      } } }),
      call(4, 'tail'), prompt(5, 'Next question'),
    ], true), false)

    expect(projection.items.map(item => item.kind === 'activity' ? item.items.map(child => child.key) : item.kind))
      .toEqual([['tool:before'], 'diff', ['tool:after'], 'text', ['tool:tail'], 'prompt'])
    expect(projection.activeActivityKey).toBeUndefined()
  })

  it('reuses content across unrelated updates and refreshes live, prepended and detail content', () => {
    const model = new TranscriptModel(true, 8)
    const history = [prompt(1, 'Question'), entry({ event: {
      type: 'user/message', seq: 2, time: 2, surfaceOp: 'append',
      data: { id: 'context', source: { kind: 'system' }, content: [{ type: 'text', text: 'Extra context' }] },
    } })]
    const initial = state(history, true, [], { turn: 1, step: 1, content: [{ type: 'text', text: 'live' }] })
    const first = model.project(initial, false)
    expect(model.project({ ...initial, projections: {} }, false)).toBe(first)
    const continuing = { ...initial, assistant: { turn: 1, step: 1, content: [{ type: 'text' as const, text: 'live continuation' }] } }
    const next = model.project(continuing, false)
    expect(next.items[0]).toBe(first.items[0])
    expect(next.items.at(-1)).toMatchObject({ body: 'live continuation' })

    const older = state([prompt(0, 'Earlier prompt'), ...history], true, [], continuing.assistant)
    expect(model.project(older, false).items[0]).toMatchObject({ body: 'Earlier prompt' })
    const detailed = model.project(older, true)
    expect(detailed.showDetails).toBe(true)
    expect(detailed.items).toContainEqual(expect.objectContaining({ label: 'Context', body: 'Extra context' }))
    expect(model.project(older, false).items.some(item => item.key === 'context:context')).toBe(false)
  })

  it('reuses tool bodies when counts grow and refreshes replaced evidence', () => {
    const model = new TranscriptModel(true, 8)
    const result = (text: string) => entry({ event: {
      type: 'tool/result', seq: 1, time: 1_100, surfaceOp: 'append', data: {
        turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'old' }, content: [
          { type: 'tool-result', content: [{ type: 'text', text }] },
        ] },
      },
    } })
    const old = call(0, 'old', '/old')
    const initialResult = result('Original evidence')
    model.project(state([old, initialResult], true), false)
    const added = call(2, 'new', '/new')
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const extended = model.project(state([old, initialResult, added], true), false)
      expect(extended.items).toMatchObject([{
        kind: 'activity', items: [{ result: 'Original evidence' }, { arguments: expect.stringContaining('/new') }],
      }])
      expect(parse).toHaveBeenCalledOnce()
      const replaced = model.project(state([old, result('Replaced evidence'), added], true), false)
      expect(replaced.items).toMatchObject([{ kind: 'activity', items: [{ result: 'Replaced evidence' }, {}] }])
      expect(parse).toHaveBeenCalledOnce()
    } finally { parse.mockRestore() }
  })
})
