import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { TuiState } from '../src/controller.ts'
import { buildTrajectoryRecords, TrajectoryView } from '../src/trajectory.ts'
import { createTheme } from '../src/theme.ts'

function toolEvents(completed: boolean): HistoryEntry[] {
  return [{
    event: {
      type: 'tool/call',
      seq: 3,
      time: 1_200,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'bash',
        arguments: '{"command":"echo NAVIGATION_OK"}',
      },
    },
    view: { for: 'call', view: { card: 'terminal', title: 'echo NAVIGATION_OK' } },
  }, ...completed ? [{
    event: {
      type: 'tool/result',
      seq: 4,
      time: 1_500,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'result-1',
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'NAVIGATION_OK' }],
            isError: false,
          }],
        },
      },
    },
    view: { for: 'result', view: { card: 'terminal', output: 'NAVIGATION_OK', exitCode: 0 } },
  }] : []] as TuiState['events']
}

function timedTraceEvents(): HistoryEntry[] {
  const tool = (
    seq: number,
    callId: string,
    title: string,
    startedAt: number,
    completedAt: number,
  ): HistoryEntry[] => [{
    event: {
      type: 'tool/call',
      seq,
      time: startedAt,
      data: {
        turn: 1,
        step: 1,
        callId,
        name: 'bash',
        arguments: `{"command":"${title}"}`,
      },
    },
    view: { for: 'call', view: { card: 'terminal', title } },
  }, {
    event: {
      type: 'tool/result',
      seq: seq + 1,
      time: completedAt,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `result-${callId}`,
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: `${title} complete` }],
            isError: false,
          }],
        },
      },
    },
    view: { for: 'result', view: { card: 'terminal', title, output: `${title} complete`, exitCode: 0 } },
  }] as TuiState['events']

  return [{
    event: { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
  }, {
    event: { type: 'step/start', seq: 1, time: 1_100, data: { turn: 1, step: 1 } },
  }, ...tool(2, 'slow', 'slow tool', 1_200, 1_900),
  ...tool(4, 'fast', 'fast tool', 1_950, 2_050), {
    event: { type: 'step/end', seq: 6, time: 2_200, data: { turn: 1, step: 1 } },
  }, {
    event: { type: 'turn/end', seq: 7, time: 2_300, data: { turn: 1, reason: { kind: 'completed' } } },
  }] as TuiState['events']
}

function state(events: HistoryEntry[], overrides: Partial<TuiState> = {}): TuiState {
  return {
    sessionId: 'session-trajectory' as SessionSummary['sessionId'],
    cwd: '/workspace',
    running: false,
    connected: true,
    events,
    historyHasMore: false,
    queue: [],
    pendingSubmissions: [],
    models: undefined,
    projections: {},
    notice: undefined,
    error: undefined,
    ...overrides,
  }
}

describe('trajectory records', () => {
  it('pairs turn, step, and tool boundaries while preserving request schema and timing', () => {
    const entries = [{
      event: { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
    }, {
      event: { type: 'step/start', seq: 1, time: 1_100, data: { turn: 1, step: 1 } },
    }, {
      event: {
        type: 'request/header',
        seq: 2,
        time: 1_150,
        data: {
          reason: 'initial',
          header: {
            config: { provider: 'deepseek', model: 'chat' },
            tools: [{ name: 'bash', description: 'Run a command', parameters: { type: 'object' } }],
          },
        },
      },
    }, ...toolEvents(true), {
      event: {
        type: 'assistant/message',
        seq: 5,
        time: 1_700,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-1',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'chat' },
            content: [{ type: 'text', text: 'Done.' }],
          },
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      },
    }, {
      event: { type: 'step/end', seq: 6, time: 1_800, data: { turn: 1, step: 1 } },
    }, {
      event: { type: 'turn/end', seq: 7, time: 1_900, data: { turn: 1, reason: { kind: 'completed' } } },
    }] as TuiState['events']

    const records = buildTrajectoryRecords(entries)

    expect(records.map(record => record.kind)).toEqual(['turn', 'step', 'request', 'tool', 'assistant'])
    expect(records[0]).toMatchObject({ status: 'completed', completedAt: 1_900 })
    expect(records[1]).toMatchObject({ status: 'completed', completedAt: 1_800 })
    expect(records[2]).toMatchObject({ turn: 1, step: 1 })
    expect(records[3]).toMatchObject({
      title: 'echo NAVIGATION_OK',
      status: 'completed',
      completedAt: 1_500,
      result: 'NAVIGATION_OK',
      schema: { name: 'bash' },
    })
  })

  it('keeps complete semantic detail while limiting only the ledger preview', () => {
    const detail = `${'Long response content '.repeat(12)}VISIBLE_TAIL`
    const entries = [{
      event: { type: 'step/start', seq: 0, time: 1_000, data: { turn: 1, step: 1 } },
    }, {
      event: {
        type: 'assistant/message',
        seq: 1,
        time: 2_500,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-long',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'chat' },
            content: [{ type: 'text', text: detail }],
          },
        },
      },
    }] as TuiState['events']

    const record = buildTrajectoryRecords(entries).at(-1)

    expect(record?.summary.endsWith('…')).toBe(true)
    expect(record?.detail).toBe(detail)
    expect(record?.detail).toContain('VISIBLE_TAIL')
  })

  it('pairs durable command lifecycle events into one semantic record', () => {
    const records = buildTrajectoryRecords([{
      event: { type: 'turn/start', seq: 0, time: 900, data: { turn: 1 } },
    }, {
      event: { type: 'step/start', seq: 1, time: 950, data: { turn: 1, step: 1 } },
    }, {
      event: {
        type: 'command/run',
        seq: 2,
        time: 1_000,
        data: {
          commandId: 'command-1',
          name: 'compact',
          args: ' focus on tests',
          source: { kind: 'user' },
        },
      },
    }, {
      event: {
        type: 'command/done',
        seq: 3,
        time: 1_250,
        data: {
          commandId: 'command-1',
          kind: 'success',
          text: 'Context compacted',
        },
      },
    }] as TuiState['events'])

    const command = records.find(record => record.kind === 'command')
    expect(command).toMatchObject({
      kind: 'command',
      title: '/compact',
      status: 'completed',
      completionType: 'command/done',
      completedAt: 1_250,
      detail: 'Context compacted',
    })
    expect(command).not.toHaveProperty('turn')
    expect(command).not.toHaveProperty('step')
  })
})

describe('TrajectoryView', () => {
  it('supports Vim j/k navigation in the ledger and detail viewport', () => {
    const assistant = {
      event: {
        type: 'assistant/message',
        seq: 5,
        time: 1_700,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-vim',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'chat' },
            content: [{ type: 'text', text: 'Vim navigation response' }],
          },
        },
      },
    } as TuiState['events'][number]
    const view = new TrajectoryView(
      state([...toolEvents(true), assistant]),
      () => 8,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    view.handleInput('k')
    view.handleInput('\r')
    expect(view.render(100).join('\n')).toContain('Trajectory · echo NAVIGATION_OK')

    view.handleInput('\t')
    const top = view.render(100)
    view.handleInput('j')
    expect(view.render(100)).not.toEqual(top)
    view.handleInput('k')
    expect(view.render(100)).toEqual(top)

    view.handleInput('\u001b')
    view.handleInput('j')
    view.handleInput('\r')
    expect(view.render(100).join('\n')).toContain('Trajectory · Assistant response')
  })

  it('navigates from the ledger through payload and result details, then back to chat', () => {
    const close = vi.fn()
    const view = new TrajectoryView(
      state(toolEvents(true)),
      () => 14,
      createTheme(false),
      async () => false,
      vi.fn(),
      close,
      vi.fn(),
    )

    expect(view.render(100).join('\n')).toContain('TOOL      echo NAVIGATION_OK · bash · Completed')
    view.handleInput('\r')
    expect(view.render(100).join('\n')).toContain('[Summary]')
    expect(view.render(100).join('\n')).toContain('Event        tool/call → tool/result')

    view.handleInput('\t')
    expect(view.render(100).join('\n')).toContain('echo NAVIGATION_OK')
    view.handleInput('\t')
    expect(view.render(100).join('\n')).toContain('NAVIGATION_OK')

    view.handleInput('\u001b')
    expect(view.render(100).join('\n')).toContain('TOOL      echo NAVIGATION_OK · bash · Completed')
    view.handleInput('\u001b')
    expect(close).toHaveBeenCalledOnce()
  })

  it('updates a pending tool record in place as its durable result arrives', () => {
    const view = new TrajectoryView(
      state(toolEvents(false), { running: true }),
      () => 12,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )
    expect(view.render(100).join('\n')).toContain('bash · Running')

    view.setState(state(toolEvents(true)))

    expect(view.render(100).join('\n')).toContain('bash · Completed')
  })

  it('keeps duration visible when a narrow ledger row truncates a long title', () => {
    const entries = toolEvents(true)
    const call = entries[0]
    if (call?.event.type === 'tool/call') {
      call.view = {
        for: 'call',
        view: { card: 'terminal', title: 'a very long tool title that cannot fit in a narrow terminal row' },
      }
    }
    const view = new TrajectoryView(
      state(entries),
      () => 10,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    const output = view.render(52).join('\n')

    expect(output).toContain('300ms')
    expect(output).toContain('…')
  })

  it('renders a responsive split trace explorer with bottleneck and complete Summary details', () => {
    const view = new TrajectoryView(
      state(timedTraceEvents()),
      () => 20,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    view.handleInput('k')
    const overview = view.render(140).join('\n')

    expect(overview).toContain('Bottleneck · slow tool · 700 ms')
    expect(overview).toContain('EXECUTION')
    expect(overview).toContain('DETAIL · slow tool')
    expect(overview).toContain('Duration     700 ms')
    expect(overview).toContain('Bottleneck   Slowest timed block in Step 1')
    expect(overview).toContain('▲')

    view.handleInput('\r')
    view.handleInput('\t')
    const input = view.render(140).join('\n')
    expect(input).toContain('[Input]')
    expect(input).toContain('Detail focus')
    expect(input).toContain('slow tool')
  })

  it('collapses and expands semantic hierarchy nodes with h/l', () => {
    const view = new TrajectoryView(
      state(timedTraceEvents()),
      () => 14,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    view.handleInput('g')
    view.handleInput('h')
    const collapsed = view.render(100).join('\n')
    expect(collapsed).toContain('1/4 visible')
    expect(collapsed).toContain('▸ ● TURN')
    expect(collapsed).not.toContain('fast tool · bash')

    view.handleInput('l')
    const expanded = view.render(100).join('\n')
    expect(expanded).toContain('4 records')
    expect(expanded).toContain('▾ ● TURN')
    expect(expanded).toContain('fast tool · bash')
  })

  it('wraps the complete Summary text instead of reusing the truncated ledger preview', () => {
    const detail = `${'Complete diagnostic sentence. '.repeat(8)}VISIBLE_TAIL`
    const entries = [{
      event: { type: 'step/start', seq: 0, time: 1_000, data: { turn: 1, step: 1 } },
    }, {
      event: {
        type: 'assistant/message',
        seq: 1,
        time: 2_500,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-summary',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'chat' },
            content: [{ type: 'text', text: detail }],
          },
        },
      },
    }] as TuiState['events']
    const view = new TrajectoryView(
      state(entries),
      () => 24,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    view.handleInput('\r')
    const output = view.render(70).join('\n')

    expect(output).toContain('Duration     1.50 s')
    expect(output).toContain('VISIBLE_TAIL')
  })

  it('pins an opened detail record while newer live events arrive', () => {
    const view = new TrajectoryView(
      state(toolEvents(false), { running: true }),
      () => 12,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )
    view.handleInput('\r')
    const assistant = {
      event: {
        type: 'assistant/message',
        seq: 5,
        time: 1_700,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-live',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'chat' },
            content: [{ type: 'text', text: 'Newer response' }],
          },
        },
      },
    } as TuiState['events'][number]

    view.setState(state([...toolEvents(true), assistant]))

    expect(view.render(100).join('\n')).toContain('Trajectory · echo NAVIGATION_OK')
    expect(view.render(100).join('\n')).not.toContain('Trajectory · Assistant response')
  })

  it('keeps Ctrl+C available for interrupting a live turn', () => {
    const interrupt = vi.fn()
    const close = vi.fn()
    const view = new TrajectoryView(
      state(toolEvents(false), { running: true }),
      () => 12,
      createTheme(false),
      async () => false,
      interrupt,
      close,
      vi.fn(),
    )

    view.handleInput('\u0003')

    expect(interrupt).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
  })

  it('loads an earlier history page from the top of the current ledger', async () => {
    const loadEarlier = vi.fn(async () => true)
    const changed = vi.fn()
    const view = new TrajectoryView(
      state(toolEvents(true), { historyHasMore: true }),
      () => 12,
      createTheme(false),
      loadEarlier,
      vi.fn(),
      vi.fn(),
      changed,
    )

    view.handleInput('\u001b[A')
    await vi.waitFor(() => { expect(loadEarlier).toHaveBeenCalledOnce() })

    expect(changed).toHaveBeenCalled()
  })
})
