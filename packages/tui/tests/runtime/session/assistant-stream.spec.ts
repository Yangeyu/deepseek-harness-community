import { describe, expect, it } from 'vitest'
import { LlmAttemptId, createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { SessionRuntime } from '../../../src/runtime/session/runtime.ts'
import { stepExecutionKey } from '../../../src/runtime/execution/projection/index.ts'
import { buildTranscriptItems } from '../../../src/modules/transcript/model.ts'

const attemptId = LlmAttemptId('attempt')
const page = { events: [], hasMore: false }
const online = { events: 'online', control: 'online' } as const

function runtime() {
  const value = new SessionRuntime(new LifecycleScope('stream-test'), SessionId('stream'), 1, '/workspace', online)
  value.setRunState('running')
  return value
}

describe('Session assistant presentation', () => {
  it('restores a reconnect prefix and replaces live text with one durable settlement', async () => {
    const value = runtime()
    value.hydrate(page, -1, { revision: 2, activeAttempt: {
      attemptId, turn: 1, step: 1, startedAfterSeq: -1, nextIndex: 1,
      stream: [{ type: 'text-chunks', time0: 10, index: 0, dt: [], texts: ['hello'] }],
    } })
    value.acceptAssistantFrame({ type: 'chunk', attemptId, revision: 3, index: 1, time: 20,
      chunk: { type: 'text-delta', index: 0, text: ' world' } })
    expect(value.current.assistant?.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(value.current.events).toEqual([])
    expect(value.historyCursor).toBe(-1)

    const session = Session.create(SessionId('stream'))
    const event = session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'hello world' }] }),
    }, { surfaceOp: 'append' })
    expect(value.appendEvent({ event })).toBe('appended')
    expect(value.current.assistant).toBeUndefined()
    value.acceptAssistantFrame({ type: 'chunk', attemptId, revision: 4, index: 2, time: 30,
      chunk: { type: 'text-delta', index: 0, text: 'late chunk' } })
    expect(value.current.assistant).toBeUndefined()
    value.acceptAssistantFrame({ type: 'end', attemptId, revision: 5, index: 2,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } })
    expect(value.current.assistant).toBeUndefined()
    expect(buildTranscriptItems(value.current, true, false, 8).filter(item => item.kind === 'text'))
      .toEqual([{ kind: 'text', key: 'assistant:1:1:text', body: 'hello world', markdown: true }])
    await value.dispose()
  })

  it('keeps request inputs identical during streaming, after settlement, and on replay', async () => {
    const value = runtime()
    const session = Session.create(SessionId('stream'))
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' } } })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('System instructions', 'test') }, { surfaceOp: 'append' })
    const prompt = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] }), { surfaceOp: 'append' })
    value.hydrate({ events: session.snapshotEvents().map(event => ({ event })), hasMore: false }, prompt.seq)
    value.acceptAssistantFrame({ type: 'start', attemptId, revision: 1, startedAfterSeq: prompt.seq, turn: 1, step: 1 })
    const readRequest = (current: SessionRuntime) => {
      const document = current.current.execution.requestDocument(stepExecutionKey(1, 1))
      expect(document.status).toBe('available')
      return document.status === 'available' ? document.read().request : undefined
    }
    const request = readRequest(value)
    expect(request).toMatchObject({
      provider: 'test', model: 'test', messages: [
        { role: 'system', content: [{ type: 'text', text: 'System instructions' }] },
        { role: 'user', content: [{ type: 'text', text: 'Question' }] },
      ],
    })
    const response = session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Answer' }] }),
    }, { surfaceOp: 'append' })
    value.appendEvent({ event: response })
    expect(readRequest(value)).toEqual(request)
    const restored = runtime()
    restored.hydrate({ events: session.snapshotEvents().map(event => ({ event })), hasMore: false }, response.seq)
    expect(readRequest(restored)).toEqual(request)
    await restored.dispose()
    await value.dispose()
  })

  it('drops abandoned and retired presentation without inserting history events', async () => {
    const value = runtime()
    value.hydrate(page, 0)
    const start = { type: 'start' as const, attemptId, revision: 1, startedAfterSeq: SessionSeq(0), turn: 1, step: 1 }
    value.acceptAssistantFrame(start)
    value.acceptAssistantFrame({ type: 'end', attemptId, revision: 2, index: 0, outcome: { kind: 'abandoned' } })
    expect(value.current.assistant).toBeUndefined()
    expect(value.current.events).toEqual([])
    await value.dispose()
    value.acceptAssistantFrame(start)
    expect(value.current.assistant).toBeUndefined()
  })
})
