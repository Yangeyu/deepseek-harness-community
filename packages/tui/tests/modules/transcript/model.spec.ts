import { describe, expect, it, vi } from 'vitest'
import { TranscriptModel } from '../../../src/modules/transcript/model.ts'
import { state, entry } from './fixtures.ts'

function call(seq: number, callId: string, path = '/project') {
  return entry({ event: {
    type: 'tool/call', seq, time: 1_000 + seq,
    data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ path }) },
  } })
}

function prompt(seq: number, text: string) {
  return entry({ event: {
    type: 'user/message', seq, time: seq, surfaceOp: 'append',
    data: { id: `prompt-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] },
  } })
}

describe('TranscriptModel', () => {
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
