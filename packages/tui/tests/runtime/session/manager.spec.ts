import { describe, expect, it, vi } from 'vitest'
import type {
  IApiClient,
  HostFrame,
  MuxFrame,
  SessionProjectionsBlock,
  RpcId,
  RpcRequest,
  SessionModels,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import { SessionManager } from '../../../src/runtime/session/manager.ts'
import { HarnessSessionTransport } from '../../../src/infrastructure/harness/session-transport.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import {
  executionStatus,
  visionExecutionKey,
} from '../../../src/runtime/execution/projection/index.ts'

const rpcId = 'rpc-test' as RpcId

interface ManagerInternals {
  handleMux(request: RpcRequest<MuxFrame>): Promise<void>
  handleHost(frame: HostFrame): void
}

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

function sessionManager(api: IApiClient): SessionManager {
  return new SessionManager(
    new LifecycleScope('session-manager-test'),
    new HarnessSessionTransport(api),
    '/workspace',
    100,
  )
}

describe('SessionManager', () => {
  it('forwards authoritative interaction resolutions for the active session', async () => {
    const { api } = fakeApi()
    const onInteraction = vi.fn()
    const manager = sessionManager(api)
    manager.onInteraction(onInteraction)
    await manager.start()
    const internals = manager as unknown as ManagerInternals

    const resolution = {
      type: 'approval/resolved',
      sessionId: manager.current.sessionId,
      approvalId: 'approval-test',
      outcome: 'cancelled',
    } as Extract<MuxFrame, { type: 'approval/resolved' }>
    await internals.handleMux({ rpcId, payload: resolution })

    expect(onInteraction).toHaveBeenCalledWith({ type: 'resolved', resolution })
    manager.dispose()
  })

  it('creates a session and preserves explicit queue and steer modes', async () => {
    const { api, prompt } = fakeApi()
    const manager = sessionManager(api)

    await manager.start()
    await manager.prompt('first', 'queue')
    await manager.prompt('insert next step', 'steer')
    manager.dispose()

    expect(manager.current.sessionId).toBe('session-test')
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

  it('reuses the execution snapshot for manager patches without execution inputs', async () => {
    const { api } = fakeApi()
    const manager = sessionManager(api)
    await manager.start()
    const execution = manager.current.execution

    manager.notice('Saved')

    expect(manager.current.execution).toBe(execution)
    expect(manager.current.notice).toBe('Saved')
    manager.dispose()
  })

  it('publishes interrupting until the authoritative Host status settles cancellation', async () => {
    const { api } = fakeApi()
    let releaseCancel: (() => void) | undefined
    api.sessions.cancel = async () => {
      await new Promise<void>(resolve => { releaseCancel = resolve })
      return ok({ accepted: true as const })
    }
    const manager = sessionManager(api)
    await manager.start()
    const internals = manager as unknown as ManagerInternals
    internals.handleHost({
      type: 'host/session-status',
      sessionId: manager.current.sessionId,
      running: true,
    } as HostFrame)

    const cancellation = manager.cancel()
    expect(manager.current.runState).toBe('interrupting')
    releaseCancel?.()
    await cancellation
    expect(manager.current.runState).toBe('interrupting')

    internals.handleHost({
      type: 'host/session-status',
      sessionId: manager.current.sessionId,
      running: false,
    } as HostFrame)
    expect(manager.current.runState).toBe('idle')
    manager.dispose()
  })

  it('restores the previous run phase when cancellation transport fails', async () => {
    const { api } = fakeApi()
    api.sessions.cancel = async () => { throw new Error('cancel unavailable') }
    const manager = sessionManager(api)
    await manager.start()
    const internals = manager as unknown as ManagerInternals
    internals.handleHost({
      type: 'host/session-status',
      sessionId: manager.current.sessionId,
      running: true,
    } as HostFrame)

    await expect(manager.cancel()).rejects.toThrow('cancel unavailable')
    expect(manager.current.runState).toBe('running')
    manager.dispose()
  })

  it('leaves Host command feedback to the durable command execution', async () => {
    const { api, prompt } = fakeApi()
    prompt.mockResolvedValue(ok({
      accepted: true as const,
      command: { kind: 'success' as const, text: 'Context compacted' },
    }))
    const manager = sessionManager(api)
    await manager.start()

    await manager.prompt('/compact', 'queue')

    expect(manager.current.notice).toBeUndefined()
    expect(manager.current.pendingSubmissions).toEqual([])
    manager.dispose()
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
    const manager = sessionManager(api)
    await manager.start()
    expect(manager.current.events).toHaveLength(1)

    let releaseCreate: (() => void) | undefined
    api.sessions.create = async () => {
      await new Promise<void>(resolve => { releaseCreate = resolve })
      return ok({ sessionId: 'session-cleared' as SessionSummary['sessionId'] })
    }
    api.sessions.history = async () => ok({ events: [], hasMore: false })
    const clearing = manager.clearSession()

    expect(manager.current.sessionId).toBeUndefined()
    expect(manager.current.events).toEqual([])
    await vi.waitFor(() => { expect(releaseCreate).toBeTypeOf('function') })
    releaseCreate?.()
    await clearing
    expect(manager.current.sessionId).toBe('session-cleared')
    manager.dispose()
  })

  it('restores the previous view when optimistic clear cannot create a session', async () => {
    const { api } = fakeApi()
    const manager = sessionManager(api)
    await manager.start()
    const previousSessionId = manager.current.sessionId
    api.host.describe = async () => { throw new Error('host unavailable') }

    const clearing = manager.clearSession()
    expect(manager.current.sessionId).toBeUndefined()
    await expect(clearing).rejects.toThrow('host unavailable')
    expect(manager.current.sessionId).toBe(previousSessionId)
    manager.dispose()
  })

  it('restores prompt admission that completes while an optimistic clear rolls back', async () => {
    const { api, prompt } = fakeApi()
    let releasePrompt: (() => void) | undefined
    prompt.mockImplementation(async () => {
      await new Promise<void>(resolve => { releasePrompt = resolve })
      return ok({ accepted: true as const })
    })
    const manager = sessionManager(api)
    await manager.start()
    const previousSessionId = manager.current.sessionId
    const submission = manager.prompt('finish during clear', 'queue')

    let rejectDescribe: (() => void) | undefined
    api.host.describe = async () => {
      await new Promise<void>(resolve => { rejectDescribe = resolve })
      throw new Error('host unavailable')
    }
    const clearing = manager.clearSession()
    expect(manager.current.sessionId).toBeUndefined()

    releasePrompt?.()
    await submission
    expect(manager.current.pendingSubmissions).toEqual([])

    await vi.waitFor(() => { expect(rejectDescribe).toBeTypeOf('function') })
    rejectDescribe?.()
    await expect(clearing).rejects.toThrow('host unavailable')
    expect(manager.current.sessionId).toBe(previousSessionId)
    expect(manager.current.pendingSubmissions[0]).toMatchObject({
      text: 'finish during clear',
      rpcId,
    })
    manager.dispose()
  })

  it('keeps a created replacement session when its initial history refresh fails', async () => {
    const { api } = fakeApi()
    const manager = sessionManager(api)
    await manager.start()
    const previousGeneration = manager.current.execution.epoch
    api.sessions.create = async () => ok({ sessionId: 'session-created' as SessionSummary['sessionId'] })
    api.sessions.history = async () => { throw new Error('history unavailable') }

    await expect(manager.clearSession()).rejects.toThrow('history unavailable')

    expect(manager.current.sessionId).toBe('session-created')
    expect(manager.current.execution.epoch).toBe(previousGeneration + 1)
    expect(manager.current.binding).toEqual({
      phase: 'active', sessionId: 'session-created', epoch: previousGeneration + 1,
    })
    expect(manager.current.error).toBe('history unavailable')
    manager.dispose()
  })

  it('exposes an initial Host failure as a failed binding', async () => {
    const { api } = fakeApi()
    api.host.describe = async () => { throw new Error('Host unavailable') }
    const manager = sessionManager(api)

    await expect(manager.start()).rejects.toThrow('Host unavailable')
    expect(manager.current.binding).toEqual({
      phase: 'failed', message: 'Host unavailable', epoch: 0,
    })
    expect(manager.current.sessionId).toBeUndefined()
    manager.dispose()
  })

  it('keeps the active epoch valid when a session resume fails', async () => {
    const { api, prompt } = fakeApi()
    let releasePrompt: (() => void) | undefined
    prompt.mockImplementation(async () => {
      await new Promise<void>(resolve => { releasePrompt = resolve })
      return ok({ accepted: true as const })
    })
    const manager = sessionManager(api)
    await manager.start()
    const epoch = manager.current.execution.epoch

    const submission = manager.prompt('keep this prompt', 'queue')
    await expect(manager.resume('missing-session')).rejects.toThrow('was not found')
    expect(manager.current.execution.epoch).toBe(epoch)
    expect(manager.current.pendingSubmissions).toHaveLength(1)

    releasePrompt?.()
    await submission
    expect(manager.current.pendingSubmissions[0]).toMatchObject({
      text: 'keep this prompt',
      rpcId,
    })
    manager.dispose()
  })

  it('publishes a local prompt before host admission completes', async () => {
    const { api, prompt } = fakeApi()
    let releasePrompt: (() => void) | undefined
    prompt.mockImplementation(async () => {
      await new Promise<void>(resolve => { releasePrompt = resolve })
      return ok({ accepted: true as const })
    })
    const manager = sessionManager(api)
    await manager.start()

    const submission = manager.prompt('show this immediately', 'queue')
    expect(manager.current.pendingSubmissions).toEqual([{
      key: 1,
      text: 'show this immediately',
      mode: 'queue',
      intent: 'working',
    }])

    releasePrompt?.()
    await submission
    expect(manager.current.pendingSubmissions[0]).toMatchObject({
      text: 'show this immediately',
      rpcId,
    })
    manager.dispose()
  })

  it('publishes an image prompt before its content preparation completes', async () => {
    const { api, prompt } = fakeApi()
    const manager = sessionManager(api)
    await manager.start()
    let releasePreparation: (() => void) | undefined

    const submission = manager.promptWithPreparation('analyze this image', 'queue', async (preparation) => {
      preparation.setActivity({ kind: 'vision', analysisId: 'analysis-1', imageCount: 1 })
      await new Promise<void>(resolve => { releasePreparation = resolve })
      return { kind: 'content', content: [{ type: 'text', text: 'prepared vision evidence' }] }
    })

    expect(manager.current.pendingSubmissions).toEqual([expect.objectContaining({
      key: 1,
      text: 'analyze this image',
      mode: 'queue',
      intent: 'working',
      activity: expect.objectContaining({ kind: 'vision', analysisId: 'analysis-1', imageCount: 1 }),
    })])
    const vision = manager.current.execution.get(visionExecutionKey('analysis-1'))
    expect(vision).toMatchObject({ durability: 'ephemeral' })
    expect(vision === undefined ? undefined : executionStatus(vision)).toBe('running')
    expect(manager.current.execution.sessionId).toBe(String(manager.current.sessionId))
    expect(prompt).not.toHaveBeenCalled()
    releasePreparation?.()
    await submission
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'prepared vision evidence' }],
    }))
    expect(manager.current.pendingSubmissions[0]).toMatchObject({
      rpcId,
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 1 },
    })
    manager.dispose()
  })

  it('accepts prepared Vision admission without resubmitting through Host prompt', async () => {
    const { api, prompt } = fakeApi()
    const manager = sessionManager(api)
    await manager.start()
    const commit = vi.fn(async () => {})

    await manager.promptWithPreparation('analyze this image', 'queue', async () => ({
      kind: 'admission',
      commit,
    }))

    expect(prompt).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ rpcId: expect.any(String) }))
    expect(manager.current.pendingSubmissions[0]).toMatchObject({
      text: 'analyze this image',
      rpcId: expect.any(String),
    })
    manager.dispose()
  })

  it('retires an optimistic image prompt when preparation fails', async () => {
    const { api, prompt } = fakeApi()
    const manager = sessionManager(api)
    await manager.start()

    await expect(manager.promptWithPreparation('retry this image', 'queue', async () => {
      throw new Error('Vision proxy failed')
    })).rejects.toThrow('Vision proxy failed')

    expect(manager.current.pendingSubmissions).toEqual([])
    expect(prompt).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('retires an optimistic image prompt when Vision admission fails', async () => {
    const { api, prompt } = fakeApi()
    const manager = sessionManager(api)
    await manager.start()

    await expect(manager.promptWithPreparation('retry this image', 'queue', async () => ({
      kind: 'admission',
      commit: async () => { throw new Error('Vision admission failed') },
    }))).rejects.toThrow('Vision admission failed')

    expect(manager.current.pendingSubmissions).toEqual([])
    expect(prompt).not.toHaveBeenCalled()
    manager.dispose()
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
    const manager = sessionManager(api)
    await manager.start()

    await expect(manager.prompt('retry me', 'queue')).rejects.toThrow('prompt rejected')
    expect(manager.current.pendingSubmissions).toEqual([])
    manager.dispose()
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
    const manager = sessionManager(api)
    await manager.start()
    await manager.prompt('queue once', 'queue')

    emit?.({
      rpcId: 'rpc-stream' as RpcId,
      payload: {
        type: 'session/queue',
        sessionId: manager.current.sessionId as SessionSummary['sessionId'],
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
    await vi.waitFor(() => { expect(manager.current.queue).toHaveLength(1) })
    expect(manager.current.pendingSubmissions).toHaveLength(1)

    await vi.waitFor(() => { expect(emit).toBeTypeOf('function') })
    emit?.({
      rpcId: 'rpc-stream-event' as RpcId,
      payload: {
        type: 'session/event',
        sessionId: manager.current.sessionId as SessionSummary['sessionId'],
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
    await vi.waitFor(() => { expect(manager.current.pendingSubmissions).toEqual([]) })
    expect(manager.current.queue).toHaveLength(1)
    manager.dispose()
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
    const manager = sessionManager(api)

    await manager.start()
    manager.dispose()

    expect(manager.current.projections.tokenUsage).toEqual({
      uncachedInputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
    })
    expect(manager.current.projections.contextPressure).toEqual({
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
    const manager = sessionManager(api)
    await manager.start()

    expect(manager.current.historyHasMore).toBe(true)
    await expect(manager.loadEarlierHistory()).resolves.toBe(true)

    expect(history).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-test',
      beforeSeq: 2,
      maxMessages: 100,
    }))
    expect(manager.current.events.map(entry => entry.event.seq)).toEqual([0, 1, 2, 3])
    expect(manager.current.historyHasMore).toBe(false)
    manager.dispose()
  })

  it('resyncs an event gap without exposing the out-of-order suffix', async () => {
    const { api } = fakeApi()
    let releaseResync!: () => void
    const history = vi.fn()
      .mockResolvedValueOnce(ok({ events: [], hasMore: false }))
      .mockImplementationOnce(async () => {
        await new Promise<void>(resolve => { releaseResync = resolve })
        return ok({
          events: [{
            event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          }, {
            event: { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
          }, {
            event: {
              type: 'turn/end',
              seq: 2,
              time: 3,
              data: { turn: 1, reason: { kind: 'completed' } },
            },
          }],
          hasMore: false,
        })
      })
    api.sessions.history = history as unknown as IApiClient['sessions']['history']
    const manager = sessionManager(api)
    await manager.start()
    const internals = manager as unknown as ManagerInternals
    const published: number[][] = []
    manager.subscribe(snapshot => { published.push(snapshot.events.map(entry => entry.event.seq)) })

    await internals.handleMux({
      rpcId,
      payload: {
        type: 'session/event',
        sessionId: manager.current.sessionId,
        event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      },
    } as RpcRequest<MuxFrame>)
    const gap = internals.handleMux({
      rpcId,
      payload: {
        type: 'session/event',
        sessionId: manager.current.sessionId,
        event: {
          type: 'turn/end',
          seq: 2,
          time: 3,
          data: { turn: 1, reason: { kind: 'completed' } },
        },
      },
    } as RpcRequest<MuxFrame>)

    await vi.waitFor(() => { expect(history).toHaveBeenCalledTimes(2) })
    expect(manager.current.events.map(entry => entry.event.seq)).toEqual([0])
    expect(published).not.toContainEqual([0, 2])

    releaseResync()
    await gap
    expect(manager.current.events.map(entry => entry.event.seq)).toEqual([0, 1, 2])
    expect(manager.current.execution.ordered().some(node => node.kind === 'turn')).toBe(true)
    manager.dispose()
  })

  it('forks at the selected Rewind turn boundary', async () => {
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
    const manager = sessionManager(api)

    await manager.start()
    const phases: string[] = []
    const rewoundSessionId = await manager.rewind({
      sessionId: String(source),
      previousTurnEndSeq: 17,
    }, phase => { phases.push(phase) })
    manager.dispose()

    expect(fork).toHaveBeenCalledWith({ sessionId: source, atSeq: 17 })
    expect(phases).toEqual(['forking', 'opening'])
    expect(rewoundSessionId).toBe(child)
    expect(manager.current.sessionId).toBe(child)
  })

  it('retires both application-scoped stream loops through the injected lifecycle', async () => {
    const { api } = fakeApi()
    let muxSignal: AbortSignal | undefined
    let hostSignal: AbortSignal | undefined
    let muxRetired = false
    let hostRetired = false
    api.events.mux = async function* (_request, signal): AsyncGenerator<never> {
      muxSignal = signal
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => {
        muxRetired = true
        resolve()
      }, { once: true }))
      if (!signal?.aborted) yield undefined as never
    }
    api.events.host = async function* (_request, signal): AsyncGenerator<never> {
      hostSignal = signal
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => {
        hostRetired = true
        resolve()
      }, { once: true }))
      if (!signal?.aborted) yield undefined as never
    }
    const manager = sessionManager(api)
    await manager.start()
    await vi.waitFor(() => {
      expect(muxSignal).toBeDefined()
      expect(hostSignal).toBeDefined()
    })

    await manager.dispose()

    expect(muxSignal?.aborted).toBe(true)
    expect(hostSignal?.aborted).toBe(true)
    expect(muxRetired).toBe(true)
    expect(hostRetired).toBe(true)
  })

})
