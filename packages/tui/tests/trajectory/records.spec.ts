import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { TuiState } from '../../src/runtime/controller.ts'
import {
  buildTrajectoryRecords,
  trajectoryTiming,
} from '../../src/trajectory/records.ts'
import { buildLifecycleSnapshot } from '../../src/runtime/lifecycle/index.ts'
import { toolEvents } from './fixtures.ts'

function records(entries: TuiState['events']) {
  const lifecycle = buildLifecycleSnapshot({
    sessionId: 'session-trajectory',
    generation: 0,
    entries,
    sessionRunning: false,
  })
  return buildTrajectoryRecords(entries, lifecycle)
}

describe('trajectory records', () => {
  it('falls back to the durable user event when lifecycle metadata is unavailable', () => {
    const entries = [{
      event: {
        type: 'user/message',
        seq: 0,
        time: 900,
        surfaceOp: 'append',
        data: {
          id: 'message-user',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Retain me' }],
        },
      },
    }] as TuiState['events']
    const lifecycle = buildLifecycleSnapshot({
      sessionId: 'session-trajectory',
      generation: 0,
      entries: [],
      sessionRunning: false,
    })

    expect(buildTrajectoryRecords(entries, lifecycle)).toEqual([
      expect.objectContaining({ kind: 'user', tone: 'info', detail: 'Retain me' }),
    ])
  })

  it('turns a supported Vision evidence message into a timed trace record after the user input', () => {
    const entries = [{
      event: {
        type: 'user/message',
        seq: 0,
        time: 900,
        surfaceOp: 'append',
        data: {
          id: 'message-user',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Analyze this image' }],
        },
      },
    }, {
      event: {
        type: 'user/message',
        seq: 1,
        time: 2_500,
        surfaceOp: 'append',
        data: {
          id: 'message-vision',
          role: 'user',
          source: {
            kind: 'community-vision',
            promptId: 'message-user',
            analysisId: 'analysis-1',
            provider: 'bailian',
            model: 'qwen3.7-plus',
            attachments: [],
            durationMs: 1_500,
            finishReason: 'stop',
            truncated: false,
          },
          content: [{ type: 'text', text: 'Visible warning banner' }],
        },
      },
    }] as TuiState['events']

    const result = records(entries)
    expect(result.map(record => record.kind)).toEqual(['user', 'vision'])
    expect(result[0]).toMatchObject({ lifecycle: { kind: 'prompt', key: 'prompt:message-user' } })
    expect(result[1]).toEqual(expect.objectContaining({
      kind: 'vision',
      title: 'Vision analysis',
      detail: 'Visible warning banner',
    }))
    expect(trajectoryTiming(result[1]!)).toEqual({ status: 'completed', startedAt: 1_000, completedAt: 2_500 })
  })

  it('projects resolved turn, step, and tool lifecycles with request schema and timing', () => {
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

    const result = records(entries)

    expect(result.map(record => record.kind)).toEqual(['turn', 'step', 'request', 'tool', 'assistant'])
    expect(trajectoryTiming(result[0]!)).toEqual({ status: 'completed', startedAt: 1_000, completedAt: 1_900 })
    expect(trajectoryTiming(result[1]!)).toEqual({ status: 'completed', startedAt: 1_100, completedAt: 1_800 })
    expect(result[2]).toMatchObject({ turn: 1, step: 1 })
    expect(result[3]).toMatchObject({
      title: 'echo NAVIGATION_OK',
      toolName: 'bash',
      summary: 'Completed',
      result: 'NAVIGATION_OK',
      schema: { name: 'bash' },
    })
    expect(trajectoryTiming(result[3]!)).toEqual({ status: 'completed', startedAt: 1_200, completedAt: 1_500 })
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

    const record = records(entries).at(-1)

    expect(record?.summary.endsWith('…')).toBe(true)
    expect(record?.detail).toBe(detail)
    expect(record?.detail).toContain('VISIBLE_TAIL')
  })

  it('projects a durable command lifecycle into one semantic record', () => {
    const result = records([{
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

    const command = result.find(record => record.kind === 'command')
    expect(command).toMatchObject({
      kind: 'command',
      title: '/compact',
      completionType: 'command/done',
      detail: 'Context compacted',
    })
    expect(command === undefined ? undefined : trajectoryTiming(command)).toEqual({
      status: 'completed',
      startedAt: 1_000,
      completedAt: 1_250,
    })
    expect(command).not.toHaveProperty('turn')
    expect(command).not.toHaveProperty('step')
  })

  it('resets semantic location when a new turn starts before a malformed prior tail closes', () => {
    const result = records([{
      event: { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
    }, {
      event: { type: 'step/start', seq: 1, time: 1_100, data: { turn: 1, step: 9 } },
    }, {
      event: { type: 'turn/start', seq: 2, time: 1_200, data: { turn: 2 } },
    }, {
      event: {
        type: 'request/header',
        seq: 3,
        time: 1_250,
        data: {
          reason: 'initial',
          header: { config: { provider: 'deepseek', model: 'chat' } },
        },
      },
    }] as TuiState['events'])

    expect(result.at(-1)).toMatchObject({ kind: 'request', turn: 2 })
    expect(result.at(-1)).not.toHaveProperty('step')
  })
})
