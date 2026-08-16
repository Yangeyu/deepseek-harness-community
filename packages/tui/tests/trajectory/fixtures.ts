import type { HistoryEntry, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { TuiState } from '../../src/runtime/controller.ts'
import { buildLifecycleSnapshot } from '../../src/runtime/lifecycle/index.ts'

export function toolEvents(completed: boolean): HistoryEntry[] {
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

export function timedTraceEvents(): HistoryEntry[] {
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

export function state(events: HistoryEntry[], overrides: Partial<TuiState> = {}): TuiState {
  const value = {
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
  return {
    ...value,
    lifecycle: buildLifecycleSnapshot({
      sessionId: value.sessionId === undefined ? undefined : String(value.sessionId),
      generation: 0,
      entries: value.events,
      sessionRunning: value.running,
    }),
  }
}
