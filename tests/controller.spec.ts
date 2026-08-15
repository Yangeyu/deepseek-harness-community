import { describe, expect, it, vi } from 'vitest'
import type {
  IApiClient,
  SessionProjectionsBlock,
  RpcId,
  SessionModels,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import {
  HarnessController,
  type TuiControllerSink,
} from '../src/controller.ts'

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
})
