import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../../../src/runtime/session/contracts.ts'
import {
  buildExecutionSnapshot,
  ExecutionProjector,
  stepExecutionKey,
  type ExecutionSnapshot,
} from '../../../../src/runtime/execution/projection/index.ts'

function entries(events: readonly unknown[]): HistoryEntry[] {
  return events.map((event, seq) => ({ event: { ...event as object, seq, time: seq * 10 } })) as HistoryEntry[]
}

function message(id: string, text: string, role = 'user') {
  return {
    id, role, content: [{ type: 'text', text }],
    source: role === 'assistant'
      ? { kind: 'model', provider: 'deepseek', model: 'chat' }
      : { kind: 'user' },
  }
}

function history(): HistoryEntry[] {
  return entries([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', surfaceOp: 'append', data: message('input', 'Original input') },
    { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'deepseek', model: 'chat' } } } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: message('reply', 'Answer', 'assistant') } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  ])
}

function input(events: readonly HistoryEntry[]) {
  return { sessionId: 'request-session', epoch: 4, entries: events, sessionRunning: true }
}

function available(snapshot: ExecutionSnapshot, step = 1) {
  const result = snapshot.requestDocument(stepExecutionKey(1, step))
  expect(result.status).toBe('available')
  if (result.status !== 'available') throw new Error('Expected canonical Request')
  return result
}

describe('canonical Request document', () => {
  it('keeps canonical compaction order and exact provenance without merging repeated text', () => {
    const checkpoint = {
      ...message('checkpoint', 'Summary'),
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' },
    }
    const events = entries([
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'system/message', surfaceOp: 'append', data: { message: { ...message('system', 'Instructions', 'system'), source: { kind: 'plugin', plugin: 'system-prompt' } } } },
      { type: 'user/message', surfaceOp: 'append', data: message('old-input', 'Repeated text') },
      { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: message('old-answer', 'Old answer', 'assistant') } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'step/start', data: { turn: 1, step: 2 } },
      { type: 'user/message', surfaceOp: 'append', data: message('retained-input', 'Repeated text') },
      { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3], data: checkpoint },
      { type: 'request/header', data: { reason: 'initial', header: {
        config: { provider: 'deepseek', model: 'chat', temperature: 0.5 },
        tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      } } },
      { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 2, stream: [], message: { ...message('empty', '', 'assistant'), content: [] } } },
      { type: 'step/end', data: { turn: 1, step: 2 } },
      { type: 'step/start', data: { turn: 1, step: 3 } },
      { type: 'user/message', surfaceOp: 'append', data: message('new-input', 'Repeated text') },
    ])
    const snapshot = buildExecutionSnapshot(input(events))
    const compacted = available(snapshot, 2).read()
    expect(compacted.request).toMatchObject({
      provider: 'deepseek', model: 'chat', temperature: 0.5,
      tools: [{ name: 'read', parameters: { properties: { path: { type: 'string' } } } }],
    })
    expect(compacted.request.messages.map(value => value.id)).toEqual(['system', 'checkpoint', 'retained-input'])
    expect(compacted.provenance.map(value => [value.seq, value.messageId])).toEqual([
      [1, 'system'], [7, 'checkpoint'], [6, 'retained-input'],
    ])
    expect(compacted.provenance[1]).toEqual({
      seq: 7, messageId: 'checkpoint', source: checkpoint.source,
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3],
    })
    const next = available(snapshot, 3).read()
    expect(next.request.messages.map(value => value.id)).toEqual(['system', 'checkpoint', 'retained-input', 'new-input'])
    expect(next.provenance.map(value => value.seq)).toEqual([1, 7, 6, 12])
  })

  it('reports missing history until the complete prefix is loaded, including interior gaps', () => {
    const projector = new ExecutionProjector()
    const events = history()
    const partial = projector.project(input(events.slice(1)))
    expect(partial.requestDocument(stepExecutionKey(1, 1))).toEqual({
      status: 'missing-history', requiredFromSeq: 0, throughSeq: 3, firstMissingSeq: 0,
    })
    const complete = projector.project(input(events))
    expect(available(complete).read().request.messages).toMatchObject([
      { content: [{ type: 'text', text: 'Original input' }] },
    ])
    const gap = projector.project(input(events.filter(entry => entry.event.seq !== 2)))
    expect(gap.requestDocument(stepExecutionKey(1, 1))).toEqual({
      status: 'missing-history', requiredFromSeq: 0, throughSeq: 3, firstMissingSeq: 2,
    })
    const restored = available(projector.project(input(events)))
    expect(restored.version).not.toBe(available(complete).version)
    expect(restored.read()).toEqual(available(complete).read())
  })

  it('distinguishes absent request evidence from missing history', () => {
    const snapshot = buildExecutionSnapshot(input(history().slice(0, 3)))
    expect(snapshot.requestDocument(stepExecutionKey(1, 1))).toEqual({ status: 'missing-request', reason: 'header' })
    expect(snapshot.requestDocument(stepExecutionKey(1, 99))).toEqual({ status: 'missing-request', reason: 'boundary' })
  })

  it('keeps the fixed request revision across unrelated appends and inert snapshot changes', () => {
    const projector = new ExecutionProjector()
    const events = history()
    const first = available(projector.project(input(events)))
    const document = first.read()
    const appended = [...events, ...entries([{ type: 'command/run', data: { commandId: 'unrelated' } }]).map(entry => ({
      event: { ...entry.event, seq: 6 },
    }))] as HistoryEntry[]
    const variants = [
      input([...events]),
      input(appended),
      { ...input(appended), sessionRunning: false },
      { ...input(appended), runtimeActivities: [{ kind: 'vision' as const, analysisId: 'vision', startedAt: 100 }] },
    ]
    for (const variant of variants) {
      const current = available(projector.project(variant))
      expect(current.identity).toEqual(first.identity)
      expect(current.version).toBe(first.version)
    }
    expect(first.identity).toEqual({ sessionId: 'request-session', epoch: 4, stepKey: stepExecutionKey(1, 1), throughSeq: 3 })
    expect(first.read()).toEqual(document)
  })

  it('revises a live boundary as input arrives and retires it on structural replacement or epoch change', () => {
    const projector = new ExecutionProjector()
    const events = history()
    const initial = available(projector.project(input(events.slice(0, 4))))
    const nextInput = entries([{ type: 'user/message', surfaceOp: 'append', data: message('follow-up', 'Extra input') }])[0]!
    const growing = [...events.slice(0, 4), { event: { ...nextInput.event, seq: 4 } }] as HistoryEntry[]
    const advanced = available(projector.project(input(growing)))
    expect(advanced.identity.throughSeq).toBe(4)
    expect(advanced.version).not.toBe(initial.version)
    expect(advanced.read().request.messages.map(value => value.id)).toEqual(['input', 'follow-up'])

    const fixed = available(projector.project(input(events)))
    const replaced = events.map(entry => entry.event.seq === 2
      ? { event: { ...entry.event, data: message('input', 'Replaced input') } } as HistoryEntry
      : entry)
    const changed = available(projector.project(input(replaced)))
    expect(changed.identity).toEqual(fixed.identity)
    expect(changed.version).not.toBe(fixed.version)
    expect(changed.read().request.messages[0]?.content).toEqual([{ type: 'text', text: 'Replaced input' }])
    const changedHeader = replaced.map(entry => entry.event.type === 'request/header'
      ? { event: { ...entry.event, data: { ...entry.event.data, header: { config: { provider: 'deepseek', model: 'reasoner' } } } } } as HistoryEntry
      : entry)
    const reconfigured = available(projector.project(input(changedHeader)))
    expect(reconfigured.version).not.toBe(changed.version)
    expect(reconfigured.read().request.model).toBe('reasoner')
    const epoch = available(projector.project({ ...input(changedHeader), epoch: 5 }))
    expect(epoch.identity.epoch).toBe(5)
    expect(epoch.version).not.toBe(reconfigured.version)
    expect(fixed.read().request.messages[0]?.content).toEqual([{ type: 'text', text: 'Original input' }])
  })
})
