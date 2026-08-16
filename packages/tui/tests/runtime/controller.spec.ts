import { describe, expect, it, vi } from 'vitest'
import type {
  IApiClient,
  GoalRef,
  MuxFrame,
  SessionProjectionsBlock,
  RpcId,
  RpcRequest,
  SessionModels,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import {
  HarnessController,
  type TuiControllerSink,
} from '../../src/runtime/controller.ts'

const rpcId = 'rpc-test' as RpcId

function ok<T>(value: T): { rpcId: RpcId; result: { ok: true; value: T } } {
  return { rpcId, result: { ok: true, value } }
}

function fakeApi(projections?: SessionProjectionsBlock): { api: IApiClient; prompt: ReturnType<typeof vi.fn> } {
  const sessionId = 'session-test' as SessionSummary['sessionId']
  const models: SessionModels = {
    current: { provider: 'deepseek', model: 'chat' },
    routable: true,
    groups: [],
    failures: [],
  }
  const prompt = vi.fn(async () => ok({ accepted: true as const }))
  const api = {
    host: {
      describe: async () => ok({
        version: 'test',
        cwd: '/workspace',
        attachedSessions: 0,
        canOpenPath: false,
      }),
    },
    sessions: {
      list: async () => ok({ items: [] }),
      create: async () => ok({ sessionId }),
      history: async () => ok({
        events: [],
        hasMore: false,
        ...projections === undefined ? {} : { projections },
      }),
      models: async () => ok(models),
      prompt,
      cancel: async () => ok({ accepted: true as const }),
      selectModel: async (request: SessionModels['current']) => ok({ selected: request }),
    },
    events: {
      async *mux(): AsyncGenerator<never> {},
      async *host(): AsyncGenerator<never> {},
    },
    respond: async () => ({ accepted: true as const }),
  } as unknown as IApiClient
  return { api, prompt }
}

describe('HarnessController', () => {
  it('creates a session and preserves explicit queue and steer modes', async () => {
    const { api, prompt } = fakeApi()
    const sink: TuiControllerSink = {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }
    const controller = new HarnessController(api, sink, '/workspace', 100)

    await controller.start()
    await controller.prompt('first', 'queue')
    await controller.prompt('insert next step', 'steer')
    controller.dispose()

    expect(controller.current.sessionId).toBe('session-test')
    expect(prompt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'session-test',
      mode: 'queue',
      content: [{ type: 'text', text: 'first' }],
    }))
    expect(prompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      mode: 'steer',
      content: [{ type: 'text', text: 'insert next step' }],
    }))
  })

  it('leaves Host command feedback to the durable command lifecycle', async () => {
    const { api, prompt } = fakeApi()
    prompt.mockResolvedValue(ok({
      accepted: true as const,
      command: { kind: 'success' as const, text: 'Context compacted' },
    }))
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()

    await controller.prompt('/compact', 'queue')

    expect(controller.current.notice).toBeUndefined()
    expect(controller.current.pendingSubmissions).toEqual([])
    controller.dispose()
  })

  it('clears the visible conversation before fresh-session creation completes', async () => {
    const { api } = fakeApi()
    api.sessions.history = async () => ok({
      events: [{
        event: {
          type: 'user/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            id: 'message-before-clear',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'old message' }],
          },
        },
      }],
      hasMore: false,
    }) as unknown as Awaited<ReturnType<IApiClient['sessions']['history']>>
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()
    expect(controller.current.events).toHaveLength(1)

    let releaseCreate: (() => void) | undefined
    api.sessions.create = async () => {
      await new Promise<void>(resolve => { releaseCreate = resolve })
      return ok({ sessionId: 'session-cleared' as SessionSummary['sessionId'] })
    }
    api.sessions.history = async () => ok({ events: [], hasMore: false })
    const clearing = controller.clearSession()

    expect(controller.current.sessionId).toBeUndefined()
    expect(controller.current.events).toEqual([])
    await vi.waitFor(() => { expect(releaseCreate).toBeTypeOf('function') })
    releaseCreate?.()
    await clearing
    expect(controller.current.sessionId).toBe('session-cleared')
    controller.dispose()
  })

  it('restores the previous view when optimistic clear cannot create a session', async () => {
    const { api } = fakeApi()
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()
    const previousSessionId = controller.current.sessionId
    api.host.describe = async () => { throw new Error('host unavailable') }

    const clearing = controller.clearSession()
    expect(controller.current.sessionId).toBeUndefined()
    await expect(clearing).rejects.toThrow('host unavailable')
    expect(controller.current.sessionId).toBe(previousSessionId)
    controller.dispose()
  })

  it('publishes a local prompt before host admission completes', async () => {
    const { api, prompt } = fakeApi()
    let releasePrompt: (() => void) | undefined
    prompt.mockImplementation(async () => {
      await new Promise<void>(resolve => { releasePrompt = resolve })
      return ok({ accepted: true as const })
    })
    const sink: TuiControllerSink = {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }
    const controller = new HarnessController(api, sink, '/workspace', 100)
    await controller.start()

    const submission = controller.prompt('show this immediately', 'queue')
    expect(controller.current.pendingSubmissions).toEqual([{
      key: 1,
      text: 'show this immediately',
      mode: 'queue',
      intent: 'working',
    }])

    releasePrompt?.()
    await submission
    expect(controller.current.pendingSubmissions[0]).toMatchObject({
      text: 'show this immediately',
      rpcId,
    })
    controller.dispose()
  })

  it('publishes an image prompt before its content preparation completes', async () => {
    const { api, prompt } = fakeApi()
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()
    let releasePreparation: (() => void) | undefined

    const submission = controller.promptWithPreparation('analyze this image', 'queue', async (preparation) => {
      preparation.setActivity({ kind: 'vision', analysisId: 'analysis-1', imageCount: 1 })
      await new Promise<void>(resolve => { releasePreparation = resolve })
      return [{ type: 'text', text: 'prepared vision evidence' }]
    })

    expect(controller.current.pendingSubmissions).toEqual([expect.objectContaining({
      key: 1,
      text: 'analyze this image',
      mode: 'queue',
      intent: 'working',
      activity: expect.objectContaining({ kind: 'vision', analysisId: 'analysis-1', imageCount: 1 }),
    })])
    expect(prompt).not.toHaveBeenCalled()
    releasePreparation?.()
    await submission
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'prepared vision evidence' }],
    }))
    expect(controller.current.pendingSubmissions[0]).toMatchObject({
      rpcId,
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 1 },
    })
    controller.dispose()
  })

  it('retires an optimistic image prompt when preparation fails', async () => {
    const { api, prompt } = fakeApi()
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()

    await expect(controller.promptWithPreparation('retry this image', 'queue', async () => {
      throw new Error('Vision proxy failed')
    })).rejects.toThrow('Vision proxy failed')

    expect(controller.current.pendingSubmissions).toEqual([])
    expect(prompt).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('retires the local prompt when Host admission rejects it', async () => {
    const { api, prompt } = fakeApi()
    prompt.mockResolvedValue({
      rpcId,
      result: {
        ok: false,
        error: { code: 'agent-busy', message: 'prompt rejected', details: {} },
      },
    })
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()

    await expect(controller.prompt('retry me', 'queue')).rejects.toThrow('prompt rejected')
    expect(controller.current.pendingSubmissions).toEqual([])
    controller.dispose()
  })

  it('keeps a local prompt through queue admission until its durable event', async () => {
    const { api } = fakeApi()
    let emit: ((frame: RpcRequest<MuxFrame>) => void) | undefined
    api.events.mux = async function* (_request, signal): AsyncGenerator<RpcRequest<MuxFrame>> {
      for (let index = 0; index < 2; index += 1) {
        const frame = await new Promise<RpcRequest<MuxFrame>>(resolve => { emit = resolve })
        emit = undefined
        if (!signal?.aborted) yield frame
      }
    }
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()
    await controller.prompt('queue once', 'queue')

    emit?.({
      rpcId: 'rpc-stream' as RpcId,
      payload: {
        type: 'session/queue',
        sessionId: controller.current.sessionId as SessionSummary['sessionId'],
        items: [{
          id: 'message-queued',
          placement: 'queued',
          message: {
            id: 'message-queued',
            role: 'user',
            source: { kind: 'user', rpcId },
            content: [{ type: 'text', text: 'queue once' }],
          },
        }],
      },
    } as unknown as RpcRequest<MuxFrame>)
    await vi.waitFor(() => { expect(controller.current.queue).toHaveLength(1) })
    expect(controller.current.pendingSubmissions).toHaveLength(1)

    await vi.waitFor(() => { expect(emit).toBeTypeOf('function') })
    emit?.({
      rpcId: 'rpc-stream-event' as RpcId,
      payload: {
        type: 'session/event',
        sessionId: controller.current.sessionId as SessionSummary['sessionId'],
        event: {
          type: 'user/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            id: 'message-queued',
            role: 'user',
            source: { kind: 'user', rpcId },
            content: [{ type: 'text', text: 'queue once' }],
          },
        },
      },
    } as unknown as RpcRequest<MuxFrame>)
    await vi.waitFor(() => { expect(controller.current.pendingSubmissions).toEqual([]) })
    expect(controller.current.queue).toHaveLength(1)
    controller.dispose()
  })

  it('hydrates the same durable token projections used by the Web composer', async () => {
    const { api } = fakeApi({
      asOfSeq: 7,
      values: {
        tokenUsage: {
          uncachedInputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 90,
          cacheWriteTokens: 0,
        },
        contextPressure: { projectedTokens: 5_000, contextWindow: 10_000 },
      },
    })
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)

    await controller.start()
    controller.dispose()

    expect(controller.current.projections.tokenUsage).toEqual({
      uncachedInputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
    })
    expect(controller.current.projections.contextPressure).toEqual({
      projectedTokens: 5_000,
      contextWindow: 10_000,
    })
  })

  it('prepends older history pages without losing the current live tail', async () => {
    const { api } = fakeApi()
    const history = vi.fn(async (request: { beforeSeq?: number }) => request.beforeSeq === undefined
      ? ok({
        events: [
          { event: { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } } },
          { event: { type: 'turn/end', seq: 3, time: 4, data: { turn: 2, reason: { kind: 'completed' } } } },
        ],
        hasMore: true,
      })
      : ok({
        events: [
          { event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } },
          { event: { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } } },
        ],
        hasMore: false,
      }))
    api.sessions.history = history as unknown as IApiClient['sessions']['history']
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()

    expect(controller.current.historyHasMore).toBe(true)
    await expect(controller.loadEarlierHistory()).resolves.toBe(true)

    expect(history).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-test',
      beforeSeq: 2,
      maxMessages: 100,
    }))
    expect(controller.current.events.map(entry => entry.event.seq)).toEqual([0, 1, 2, 3])
    expect(controller.current.historyHasMore).toBe(false)
    controller.dispose()
  })

  it('forks at the boundary before the checkpointed turn', async () => {
    const source = 'session-source' as SessionSummary['sessionId']
    const child = 'session-child' as SessionSummary['sessionId']
    const fork = vi.fn(async () => ok({ sessionId: child }))
    const models: SessionModels = {
      current: { provider: 'deepseek', model: 'chat' },
      routable: true,
      groups: [],
      failures: [],
    }
    const api = {
      host: { describe: async () => ok({ version: 'test', cwd: '/workspace', attachedSessions: 0, canOpenPath: false }) },
      sessions: {
        list: async () => ok({
          items: [{ sessionId: child, updatedAt: 1, running: false, blank: false, cwd: '/workspace' }],
        }),
        create: async (request: { sessionId?: SessionSummary['sessionId'] }) => ok({ sessionId: request.sessionId ?? source }),
        history: async () => ok({ events: [], hasMore: false }),
        models: async () => ok(models),
        fork,
      },
      events: { async *mux(): AsyncGenerator<never> {}, async *host(): AsyncGenerator<never> {} },
      respond: async () => ({ accepted: true as const }),
    } as unknown as IApiClient
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)

    await controller.start()
    const phases: string[] = []
    const rewoundSessionId = await controller.rewind({
      checkpointId: 'checkpoint-1',
      sessionId: String(source),
      turn: 3,
      prompt: 'redo this',
      createdAt: 1,
      previousTurnEndSeq: 17,
      files: [],
      currentTree: 'tree',
    }, phase => { phases.push(phase) })
    controller.dispose()

    expect(fork).toHaveBeenCalledWith({ sessionId: source, atSeq: 17 })
    expect(phases).toEqual(['forking', 'opening'])
    expect(rewoundSessionId).toBe(child)
    expect(controller.current.sessionId).toBe(child)
  })

  it('routes Goal mutations through structured CAS RPCs', async () => {
    const { api } = fakeApi()
    const nextRef = { id: 'goal-next', revision: 4 } as GoalRef
    const create = vi.fn(async () => ok({ ref: nextRef }))
    const edit = vi.fn(async () => ok({ ref: nextRef }))
    api.goals = {
      create,
      edit,
      pause: async () => ok({ ref: nextRef }),
      resume: async () => ok({ ref: nextRef }),
      complete: async () => ok({ ref: nextRef }),
      clear: async () => ok({ cleared: true as const }),
    }
    const controller = new HarnessController(api, {
      render: vi.fn(),
      requestApproval: vi.fn(),
      requestQuestions: vi.fn(),
    }, '/workspace', 100)
    await controller.start()

    const created = await controller.createGoal('Ship it', 8)
    await controller.editGoal(created, 'Ship safely', 10)

    expect(create).toHaveBeenCalledWith({
      sessionId: 'session-test',
      objective: 'Ship it',
      maxGoalRounds: 8,
    })
    expect(edit).toHaveBeenCalledWith({
      sessionId: 'session-test',
      ref: nextRef,
      objective: 'Ship safely',
      maxGoalRounds: 10,
    })
    controller.dispose()
  })
})
