import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
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
})

describe('TrajectoryView', () => {
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

    expect(view.render(100).join('\n')).toContain('TOOL      bash · Completed')
    view.handleInput('\r')
    expect(view.render(100).join('\n')).toContain('[Summary]')
    expect(view.render(100).join('\n')).toContain('Event: tool/call → tool/result')

    view.handleInput('\t')
    expect(view.render(100).join('\n')).toContain('echo NAVIGATION_OK')
    view.handleInput('\t')
    expect(view.render(100).join('\n')).toContain('NAVIGATION_OK')

    view.handleInput('\u001b')
    expect(view.render(100).join('\n')).toContain('TOOL      bash · Completed')
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
