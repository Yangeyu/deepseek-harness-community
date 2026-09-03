import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { packChunkRuns, type StorageRecord } from '@deepseek-ai/dsh-session/chunk-rows'
import { describe, expect, it, vi } from 'vitest'
import { HarnessSessionTransport } from '../../../src/infrastructure/harness/session-transport.ts'

function historyRecord(record: StorageRecord) {
  if (record.type !== 'text-chunks'
    && record.type !== 'reasoning-chunks'
    && record.type !== 'tool-call-chunks') {
    return { type: 'event', event: record } as never
  }
  return {
    type: 'chunks',
    event: {
      type: `chunkrow/${record.type}`,
      seq: record.seq0,
      time: record.time0,
      data: record.data,
    },
  } as never
}

function transportFor(records: ReturnType<typeof historyRecord>[], definition: object) {
  const page = vi.fn(async () => ({ records, hasMore: true }))
  return new HarnessSessionTransport({
    cwd: '/workspace',
    controller: { page } as never,
    tools: { get: vi.fn(() => definition) } as never,
    toolScope: () => undefined as never,
    onStatus: () => () => {},
    onError: () => () => {},
  })
}

describe('HarnessSessionTransport', () => {
  it('reconstructs one replayable TUI history page from Controller records', async () => {
    const id = SessionId('history')
    const callId = ToolCallId('call-1')
    const session = Session.create(id)
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    })
    for (const text of ['a', 'b', 'c']) {
      session.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text },
      })
    }
    const result = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'contents' }],
        isError: false,
      }),
      meta: { path: 'a.txt' },
    }, { surfaceOp: 'append' })
    const presentCall = vi.fn(() => ({ card: 'generic', title: 'Read a.txt', kind: 'read' }))
    const presentResult = vi.fn(() => ({ card: 'generic', title: 'Read a.txt', kind: 'read' }))
    const records = packChunkRuns(session.snapshotEvents()).map(historyRecord)
    const transport = transportFor(records, { presentCall, presentResult })
    const signal = new AbortController().signal

    const loaded = await transport.page({
      sessionId: id,
      throughSeq: result.seq,
      maxMessages: 20,
    }, signal)

    expect(loaded.events.map(entry => entry.event.type)).toEqual([
      'tool/call',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'tool/result',
    ])
    expect(loaded.events.flatMap(entry => entry.view === undefined ? [] : [entry.view])).toEqual([
      { for: 'call', view: { card: 'generic', title: 'Read a.txt', kind: 'read' } },
      { for: 'result', view: { card: 'generic', title: 'Read a.txt', kind: 'read' } },
    ])
    expect(presentCall).toHaveBeenCalledWith({ path: 'a.txt' })
    expect(presentResult).toHaveBeenCalledWith({ path: 'a.txt' }, {
      content: [{ type: 'text', text: 'contents' }],
      isError: false,
      meta: { path: 'a.txt' },
    })
  })
})
