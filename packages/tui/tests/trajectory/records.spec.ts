import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { TuiState } from '../../src/runtime/controller.ts'
import { buildTrajectoryRecords } from '../../src/trajectory/records.ts'
import { toolEvents } from './fixtures.ts'

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
