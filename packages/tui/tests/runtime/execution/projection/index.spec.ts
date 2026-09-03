import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@vascent/deepseek-harness-vision'
import {
  aggregateExecution,
  buildExecutionSnapshot,
  commandExecutionKey,
  executionStatus,
  executionEndedAt,
  executionStartedAt,
  ExecutionProjector,
  promptExecutionKey,
  stepExecutionKey,
  thoughtExecutionKey,
  toolExecutionKey,
  turnExecutionKey,
  visionExecutionKey,
} from '../../../../src/runtime/execution/projection/index.ts'
import {
  EXECUTION_DIAGNOSTIC_LIMIT,
  ExecutionReducer,
} from '../../../../src/runtime/execution/projection/reducer.ts'

function entries(values: readonly unknown[]): HistoryEntry[] {
  return values as HistoryEntry[]
}

function build(values: readonly unknown[], running = false) {
  return buildExecutionSnapshot({
    sessionId: 'session-test',
    epoch: 4,
    entries: entries(values),
    sessionRunning: running,
  })
}

describe('execution projection', () => {
  it('enforces pending, running, and terminal transitions in one reducer', () => {
    const reducer = new ExecutionReducer()
    const key = commandExecutionKey('transition')
    reducer.declare(key, 'command', undefined, { seq: 1, time: 100, source: 'runtime' }, 'ephemeral')
    reducer.start(key, 'command', undefined, { seq: 2, time: 110, source: 'event' })
    reducer.settle(key, 'command', undefined, 'completed', { seq: 3, time: 120, source: 'event' })
    reducer.start(key, 'command', undefined, { seq: 4, time: 130, source: 'event' })
    reducer.settle(key, 'command', undefined, 'failed', { seq: 5, time: 140, source: 'event' })

    const result = reducer.result()
    expect(result.nodes).toHaveLength(1)
    expect(executionStatus(result.nodes[0]!)).toBe('completed')
    expect(result.nodes[0]).toMatchObject({ durability: 'ephemeral' })
    expect(result.diagnostics.map(issue => issue.code)).toEqual([
      'terminal-reopened',
      'conflicting-outcome',
    ])
    expect(Object.isFrozen(result.nodes[0]?.state)).toBe(true)
    expect(Object.isFrozen(result.nodes[0]?.state.phase === 'settled'
      ? result.nodes[0].state.ended
      : undefined)).toBe(true)
  })

  it('deduplicates and bounds diagnostics for malformed compatible histories', () => {
    const reducer = new ExecutionReducer()
    const key = commandExecutionKey('diagnostic')
    reducer.diagnose('missing-start', 'duplicate', key, 1)
    reducer.diagnose('missing-start', 'duplicate', key, 1)
    for (let seq = 2; seq <= EXECUTION_DIAGNOSTIC_LIMIT + 20; seq += 1) {
      reducer.diagnose('missing-start', `issue ${String(seq)}`, key, seq)
    }

    const diagnostics = reducer.result().diagnostics
    expect(diagnostics).toHaveLength(EXECUTION_DIAGNOSTIC_LIMIT)
    expect(diagnostics.filter(issue => issue.message === 'duplicate')).toHaveLength(1)
  })

  it('folds one turn tree with stable semantic keys and recorded boundaries', () => {
    const snapshot = build([
      { event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
      { event: { type: 'step/start', seq: 1, time: 110, data: { turn: 1, step: 1 } } },
      { event: { type: 'tool/call', seq: 2, time: 120, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } } },
      {
        event: {
          type: 'tool/result',
          seq: 3,
          time: 140,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'result-1',
              role: 'user',
              source: { kind: 'tool', callId: 'call-1' },
              content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], isError: false }],
            },
          },
        },
      },
      { event: { type: 'step/end', seq: 4, time: 150, data: { turn: 1, step: 1 } } },
      { event: { type: 'turn/end', seq: 5, time: 160, data: { turn: 1, reason: { kind: 'completed' } } } },
    ])

    const turn = snapshot.get(turnExecutionKey(1))
    const step = snapshot.get(stepExecutionKey(1, 1))
    const tool = snapshot.get(toolExecutionKey('call-1'))
    expect(snapshot.ordered().map(node => node.key)).toEqual([
      turnExecutionKey(1),
      stepExecutionKey(1, 1),
      toolExecutionKey('call-1'),
    ])
    expect(turn === undefined ? undefined : executionStatus(turn)).toBe('completed')
    expect(step === undefined ? undefined : executionStatus(step)).toBe('completed')
    expect(tool === undefined ? undefined : executionStatus(tool)).toBe('completed')
    expect(tool === undefined ? undefined : executionStartedAt(tool)).toBe(120)
    expect(tool === undefined ? undefined : executionEndedAt(tool)).toBe(140)
    expect(snapshot.entry(tool?.state.phase === 'settled' ? tool.state.ended.seq : undefined)?.event.type).toBe('tool/result')
    expect(snapshot.childrenOf(stepExecutionKey(1, 1)).map(node => node.key)).toEqual([toolExecutionKey('call-1')])
    expect(snapshot.diagnostics()).toEqual([])
  })

  it('settles Thought as soon as non-empty answer text starts', () => {
    const snapshot = build([
      { event: { type: 'step/start', seq: 0, time: 100, data: { turn: 1, step: 2 } } },
      { event: { type: 'assistant/chunk', seq: 1, time: 110, data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'reason' } } } },
      { event: { type: 'assistant/chunk', seq: 2, time: 130, data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 1, text: 'answer' } } } },
    ])

    const thought = snapshot.get(thoughtExecutionKey(1, 2))
    expect(thought === undefined ? undefined : executionStatus(thought)).toBe('completed')
    expect(thought === undefined ? undefined : executionStartedAt(thought)).toBe(110)
    expect(thought === undefined ? undefined : executionEndedAt(thought)).toBe(130)
  })

  it('reuses execution semantics for inert stream deltas and rebuilds at boundaries', () => {
    const projection = new ExecutionProjector()
    const history = entries([
      { event: { type: 'step/start', seq: 0, time: 100, data: { turn: 1, step: 2 } } },
      { event: { type: 'assistant/chunk', seq: 1, time: 110, data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'one' } } } },
    ])
    const input = (current: HistoryEntry[]) => ({
      sessionId: 'session-test', epoch: 4, entries: current, sessionRunning: true,
    })
    const started = projection.project(input(history))
    const continuedHistory = [...history, ...entries([
      { event: { type: 'assistant/chunk', seq: 2, time: 120, data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'two' } } } },
    ])]
    const continued = projection.project(input(continuedHistory))
    expect(continued).toBe(started)

    const answeredHistory = [...continuedHistory, ...entries([
      { event: { type: 'assistant/chunk', seq: 3, time: 130, data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 1, text: 'answer' } } } },
    ])]
    const answered = projection.project(input(answeredHistory))
    expect(answered).not.toBe(continued)
    expect(executionStatus(answered.get(thoughtExecutionKey(1, 2))!)).toBe('completed')

    const completedHistory = [...answeredHistory, ...entries([
      { event: { type: 'assistant/chunk', seq: 4, time: 140, data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 1, text: ' more' } } } },
    ])]
    const completed = projection.project(input(completedHistory))
    expect(completed).toBe(answered)
    const rebuilt = buildExecutionSnapshot(input(completedHistory))
    expect(completed.ordered()).toEqual(rebuilt.ordered())
    expect(completed.diagnostics()).toEqual(rebuilt.diagnostics())
  })

  it('applies only the accepted suffix at a semantic boundary', () => {
    const projection = new ExecutionProjector()
    const start = vi.spyOn(ExecutionReducer.prototype, 'start')
    const prefix = entries([{
      event: { type: 'command/run', seq: 0, time: 100, data: { commandId: 'incremental' } },
    }])
    projection.project({
      sessionId: 'session-test', epoch: 4, entries: prefix, sessionRunning: true,
    })
    start.mockClear()

    const snapshot = projection.project({
      sessionId: 'session-test',
      epoch: 4,
      entries: [...prefix, ...entries([{
        event: { type: 'command/done', seq: 1, time: 120, data: { commandId: 'incremental', kind: 'success' } },
      }])],
      sessionRunning: false,
    })

    expect(start).not.toHaveBeenCalled()
    expect(executionStatus(snapshot.get(commandExecutionKey('incremental'))!)).toBe('completed')
    start.mockRestore()
  })

  it('matches canonical replay for every append partition and presentation overlay', () => {
    const history = entries([
      { event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
      { event: { type: 'step/start', seq: 1, time: 110, data: { turn: 1, step: 1 } } },
      { event: { type: 'assistant/chunk', seq: 2, time: 120, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'reason' } } } },
      { event: { type: 'assistant/chunk', seq: 3, time: 130, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'answer' } } } },
      { event: { type: 'tool/call', seq: 4, time: 140, data: { turn: 1, step: 1, callId: 'partitioned', name: 'read', arguments: '{}' } } },
      {
        event: {
          type: 'tool/result',
          seq: 5,
          time: 160,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'result-partitioned',
              role: 'user',
              source: { kind: 'tool', callId: 'partitioned' },
              content: [{ type: 'tool-result', toolCallId: 'partitioned', content: [], isError: false }],
            },
          },
        },
      },
      { event: { type: 'step/end', seq: 6, time: 170, data: { turn: 1, step: 1 } } },
      { event: { type: 'turn/end', seq: 7, time: 180, data: { turn: 1, reason: { kind: 'completed' } } } },
    ])
    const semanticValue = (snapshot: ReturnType<typeof buildExecutionSnapshot>) => ({
      nodes: snapshot.ordered(),
      active: snapshot.active(),
      diagnostics: snapshot.diagnostics(),
    })

    for (let split = 0; split <= history.length; split += 1) {
      const projection = new ExecutionProjector()
      projection.project({
        sessionId: 'session-test',
        epoch: 4,
        entries: history.slice(0, split),
        sessionRunning: true,
      })
      const incremental = projection.project({
        sessionId: 'session-test',
        epoch: 4,
        entries: history,
        sessionRunning: false,
      })
      const canonical = buildExecutionSnapshot({
        sessionId: 'session-test',
        epoch: 4,
        entries: history,
        sessionRunning: false,
      })
      expect(semanticValue(incremental)).toEqual(semanticValue(canonical))
    }
  })

  it('does not persist idle-tail interruption into the durable accumulator', () => {
    const projection = new ExecutionProjector()
    const history = entries([{
      event: { type: 'command/run', seq: 0, time: 100, data: { commandId: 'reconnect' } },
    }])
    const idle = projection.project({
      sessionId: 'session-test', epoch: 4, entries: history, sessionRunning: false,
    })
    const live = projection.project({
      sessionId: 'session-test', epoch: 4, entries: history, sessionRunning: true,
    })

    expect(executionStatus(idle.get(commandExecutionKey('reconnect'))!)).toBe('interrupted')
    expect(executionStatus(live.get(commandExecutionKey('reconnect'))!)).toBe('running')
    expect(live.diagnostics()).toEqual([])
  })

  it('closes unmatched children from structural parents without hiding missing results', () => {
    const snapshot = build([
      { event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
      { event: { type: 'step/start', seq: 1, time: 110, data: { turn: 1, step: 1 } } },
      { event: { type: 'assistant/chunk', seq: 2, time: 120, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'reason' } } } },
      { event: { type: 'tool/call', seq: 3, time: 125, data: { turn: 1, step: 1, callId: 'lost', name: 'read', arguments: '{}' } } },
      { event: { type: 'step/end', seq: 4, time: 140, data: { turn: 1, step: 1 } } },
      { event: { type: 'turn/end', seq: 5, time: 150, data: { turn: 1, reason: { kind: 'completed' } } } },
    ])

    expect(executionStatus(snapshot.get(thoughtExecutionKey(1, 1))!)).toBe('completed')
    expect(executionStatus(snapshot.get(toolExecutionKey('lost'))!)).toBe('interrupted')
    expect(snapshot.diagnostics().map(issue => issue.code)).toContain('tool-result-missing')
  })

  it('materializes a structural step when a paged window starts at child activity', () => {
    const snapshot = build([
      { event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
      { event: { type: 'assistant/chunk', seq: 1, time: 110, data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'reason' } } } },
      { event: { type: 'tool/call', seq: 2, time: 120, data: { turn: 1, step: 2, callId: 'paged', name: 'read', arguments: '{}' } } },
      { event: { type: 'turn/end', seq: 3, time: 150, data: { turn: 1, reason: { kind: 'error', error: { message: 'stopped' } } } } },
    ])

    expect(executionStatus(snapshot.get(stepExecutionKey(1, 2))!)).toBe('failed')
    expect(executionStatus(snapshot.get(thoughtExecutionKey(1, 2))!)).toBe('failed')
    expect(executionStatus(snapshot.get(toolExecutionKey('paged'))!)).toBe('failed')
    expect(executionStartedAt(snapshot.get(thoughtExecutionKey(1, 2))!)).toBe(110)
    expect(executionEndedAt(snapshot.get(thoughtExecutionKey(1, 2))!)).toBe(150)
  })

  it('keeps known terminal evidence when the start lies outside the window', () => {
    const snapshot = build([{
      event: {
        type: 'command/done',
        seq: 8,
        time: 200,
        data: { commandId: 'orphan', kind: 'error', text: 'failed' },
      },
    }])

    const command = snapshot.get(commandExecutionKey('orphan'))
    expect(command === undefined ? undefined : executionStatus(command)).toBe('failed')
    expect(snapshot.diagnostics().map(issue => issue.code)).toContain('missing-start')
  })

  it('fills a missing start without changing identity when older history is prepended', () => {
    const result = {
      event: {
        type: 'tool/result',
        seq: 2,
        time: 140,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'result-prepend',
            role: 'user',
            source: { kind: 'tool', callId: 'call-prepend' },
            content: [{ type: 'tool-result', toolCallId: 'call-prepend', content: [], isError: false }],
          },
        },
      },
    }
    const tail = build([result])
    const combined = build([
      {
        event: {
          type: 'tool/call',
          seq: 1,
          time: 120,
          data: { turn: 1, step: 1, callId: 'call-prepend', name: 'read', arguments: '{}' },
        },
      },
      result,
    ])
    const key = toolExecutionKey('call-prepend')

    expect(tail.get(key)?.key).toBe(key)
    expect(executionStartedAt(tail.get(key)!)).toBeUndefined()
    expect(combined.get(key)?.key).toBe(key)
    expect(executionStartedAt(combined.get(key)!)).toBe(120)
    expect(executionStatus(combined.get(key)!)).toBe('completed')
  })

  it('settles unknown future Turn reasons conservatively and records a diagnostic', () => {
    const snapshot = build([
      { event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
      { event: { type: 'turn/end', seq: 1, time: 120, data: { turn: 1, reason: { kind: 'future-reason' } } } },
    ])

    expect(executionStatus(snapshot.get(turnExecutionKey(1))!)).toBe('interrupted')
    expect(snapshot.diagnostics().map(issue => issue.code)).toContain('unknown-turn-reason')
  })

  it('ignores replacement assistant messages as non-execution surface updates', () => {
    const snapshot = build([{
      event: {
        type: 'assistant/message',
        seq: 0,
        time: 100,
        surfaceOp: 'replace',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'replacement',
            role: 'assistant',
            source: { kind: 'model', provider: 'test', model: 'test' },
            content: [{ type: 'reasoning', text: 'replacement context' }],
          },
        },
      },
    }])

    expect(snapshot.ordered()).toEqual([])
  })

  it('diagnoses a structural parent missing from the loaded window', () => {
    const snapshot = build([
      { event: { type: 'step/start', seq: 4, time: 100, data: { turn: 2, step: 3 } } },
      { event: { type: 'step/end', seq: 5, time: 120, data: { turn: 2, step: 3 } } },
    ])

    expect(executionStatus(snapshot.get(stepExecutionKey(2, 3))!)).toBe('completed')
    expect(snapshot.diagnostics().map(issue => issue.code)).toContain('missing-parent')
  })

  it('folds a long sequential history without retaining settled nodes in open indexes', () => {
    const history: unknown[] = []
    for (let turn = 1; turn <= 2_500; turn += 1) {
      const seq = (turn - 1) * 4
      history.push(
        { event: { type: 'turn/start', seq, time: seq, data: { turn } } },
        { event: { type: 'step/start', seq: seq + 1, time: seq + 1, data: { turn, step: 1 } } },
        { event: { type: 'step/end', seq: seq + 2, time: seq + 2, data: { turn, step: 1 } } },
        { event: { type: 'turn/end', seq: seq + 3, time: seq + 3, data: { turn, reason: { kind: 'completed' } } } },
      )
    }

    const snapshot = build(history)
    expect(snapshot.ordered()).toHaveLength(5_000)
    expect(snapshot.active()).toEqual([])
    expect(snapshot.diagnostics()).toEqual([])
  })

  it('interrupts an open idle tail but leaves a live tail running', () => {
    const history = [
      { event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
      { event: { type: 'step/start', seq: 1, time: 110, data: { turn: 1, step: 1 } } },
      { event: { type: 'tool/call', seq: 2, time: 120, data: { turn: 1, step: 1, callId: 'open', name: 'read', arguments: '{}' } } },
    ]
    const idle = build(history)
    const live = build(history, true)

    expect(executionStatus(idle.get(toolExecutionKey('open'))!)).toBe('interrupted')
    expect(executionEndedAt(idle.get(toolExecutionKey('open'))!)).toBeUndefined()
    expect(idle.diagnostics().map(issue => issue.code)).toContain('open-node-idle-tail')
    expect(executionStatus(live.get(toolExecutionKey('open'))!)).toBe('running')
  })

  it('reconciles runtime Vision work with durable evidence by one identity', () => {
    const running = buildExecutionSnapshot({
      sessionId: 'session-test',
      epoch: 2,
      entries: [],
      sessionRunning: false,
      runtimeActivities: [{ kind: 'vision', analysisId: 'analysis-1', startedAt: 500 }],
    })
    expect(running.ordered()).toHaveLength(1)
    expect(running.get(visionExecutionKey('analysis-1'))).toMatchObject({ durability: 'ephemeral' })

    const durable = buildExecutionSnapshot({
      sessionId: 'session-test',
      epoch: 2,
      entries: entries([{
        event: {
          type: 'user/message',
          seq: 0,
          time: 800,
          surfaceOp: 'append',
          data: {
            id: 'vision-message',
            role: 'user',
            source: {
              kind: 'community-vision',
              promptId: 'missing-prompt',
              analysisId: 'analysis-1',
              provider: 'bailian',
              model: 'qwen',
              attachments: [],
              durationMs: 300,
              finishReason: 'stop',
              truncated: false,
            },
            content: [{ type: 'text', text: 'evidence' }],
          },
        },
      }]),
      sessionRunning: false,
      runtimeActivities: [{ kind: 'vision', analysisId: 'analysis-1', startedAt: 500 }],
    })

    const vision = durable.get(visionExecutionKey('analysis-1'))
    expect(durable.ordered()).toHaveLength(1)
    expect(vision).toMatchObject({ durability: 'durable' })
    expect(vision === undefined ? undefined : executionStatus(vision)).toBe('completed')
    expect(vision === undefined ? undefined : executionStartedAt(vision)).toBe(500)
    expect(vision === undefined ? undefined : executionEndedAt(vision)).toBe(800)
  })

  it('models an image prompt once and nests Vision evidence beneath it', () => {
    const snapshot = build([
      { event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
      {
        event: {
          type: 'user/message',
          seq: 1,
          time: 120,
          surfaceOp: 'append',
          data: {
            id: 'image-prompt',
            role: 'user',
            source: { kind: 'user', rpcId: 'rpc-image' },
            content: [{ type: 'text', text: 'inspect image' }],
          },
        },
      },
      {
        event: {
          type: 'user/message',
          seq: 2,
          time: 420,
          surfaceOp: 'append',
          data: {
            id: 'vision-evidence',
            role: 'user',
            source: {
              kind: 'community-vision',
              promptId: 'image-prompt',
              analysisId: 'analysis-image',
              provider: 'bailian',
              model: 'qwen',
              attachments: [],
              durationMs: 300,
              finishReason: 'stop',
              truncated: false,
            },
            content: [{ type: 'text', text: 'vision observation' }],
          },
        },
      },
      { event: { type: 'turn/end', seq: 3, time: 450, data: { turn: 1, reason: { kind: 'completed' } } } },
    ])
    const promptKey = promptExecutionKey('image-prompt')
    const visionKey = visionExecutionKey('analysis-image')

    expect(snapshot.ordered().map(node => node.key)).toEqual([
      turnExecutionKey(1),
      promptKey,
      visionKey,
    ])
    expect(snapshot.get(promptKey)).toMatchObject({
      kind: 'prompt',
      parentKey: turnExecutionKey(1),
      state: { phase: 'settled', outcome: 'completed' },
    })
    expect(snapshot.get(visionKey)).toMatchObject({
      kind: 'vision',
      parentKey: promptKey,
      state: { phase: 'settled', outcome: 'completed' },
    })
    expect(snapshot.ordered().filter(node => node.kind === 'prompt')).toHaveLength(1)
    expect(snapshot.diagnostics()).toEqual([])
  })

  it('uses one aggregate precedence and complete timing rule', () => {
    const snapshot = build([
      { event: { type: 'command/run', seq: 0, time: 100, data: { commandId: 'a', name: 'a', source: { kind: 'user' } } } },
      { event: { type: 'command/done', seq: 1, time: 150, data: { commandId: 'a', kind: 'success' } } },
      { event: { type: 'command/run', seq: 2, time: 160, data: { commandId: 'b', name: 'b', source: { kind: 'user' } } } },
      { event: { type: 'command/done', seq: 3, time: 220, data: { commandId: 'b', kind: 'error', text: 'bad' } } },
    ])
    expect(aggregateExecution(snapshot.ordered())).toEqual({ status: 'failed', startedAt: 100, endedAt: 220 })
  })
})
