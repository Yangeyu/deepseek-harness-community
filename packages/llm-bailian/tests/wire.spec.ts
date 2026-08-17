import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  BailianAdapter,
  BAILIAN_PROVIDER_ID,
  createBailianProfile,
  resolveBailianConfig,
  type BailianModelConfig,
} from '../src/index.ts'

interface WireRequest {
  model?: string
  messages?: Array<{ role?: string; content?: unknown }>
  reasoning_effort?: string
  enable_thinking?: boolean
  thinking_budget?: number
  max_completion_tokens?: number
  store?: boolean
}

const servers: Server[] = []

function deepseekModel(id = 'deepseek-v4-pro-0813'): BailianModelConfig {
  return {
    id,
    contextWindow: 1_000_000,
    maxTokens: 393_216,
    input: ['text'],
    reasoning: {
      defaultEffort: 'high',
      efforts: ['low', 'high', 'max'],
    },
  }
}

function qwenModel(thinkingBudget?: number): BailianModelConfig {
  return {
    id: 'qwen3.7-plus',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text', 'image'],
    reasoning: {
      defaultEffort: 'high',
      ...thinkingBudget === undefined ? {} : { thinkingBudget },
    },
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })))
})

async function endpoint(requests: WireRequest[]): Promise<string> {
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    requests.push(JSON.parse(body) as WireRequest)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: requests.at(-1)?.model,
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      })}`,
      '',
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: requests.at(-1)?.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function consume(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Bailian wire contract', () => {
  it('uses system role and configured reasoning_effort, including max, off, and model default', async () => {
    const requests: WireRequest[] = []
    const baseURL = await endpoint(requests)
    const profile = createBailianProfile(resolveBailianConfig({
      baseURL,
      models: [deepseekModel()],
    }))
    const profiles = new Map([[BAILIAN_PROVIDER_ID, profile]])
    const adapter = new BailianAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
    })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    })

    const maxChunks = await consume(adapter.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'deepseek-v4-pro-0813',
      reasoningEffort: ReasoningEffortId('max'),
      system: 'system prompt',
      messages: [message],
      maxTokens: 123,
    }))
    expect(maxChunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok')).toBe(true)
    expect(requests[0]).toMatchObject({
      model: 'deepseek-v4-pro-0813',
      reasoning_effort: 'max',
      enable_thinking: true,
      max_completion_tokens: 123,
    })
    expect(requests[0]?.messages?.[0]?.role).toBe('system')
    expect(requests[0]?.messages?.some(message => message.role === 'developer')).toBe(false)
    expect(requests[0]?.store).toBeUndefined()

    await consume(adapter.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'deepseek-v4-pro-0813',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [message],
    }))
    expect(requests[1]?.enable_thinking).toBe(false)
    expect(requests[1]?.reasoning_effort).toBeUndefined()

    await consume(adapter.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'deepseek-v4-pro-0813',
      messages: [message],
    }))
    expect(requests[2]).toMatchObject({
      reasoning_effort: 'high',
      enable_thinking: true,
    })
  })

  it('dispatches a custom model without a model-id or mode branch', async () => {
    const requests: WireRequest[] = []
    const baseURL = await endpoint(requests)
    const profile = createBailianProfile(resolveBailianConfig({
      baseURL,
      models: [{
        ...deepseekModel('private-deployment-v7'),
        contextWindow: 100_000,
        maxTokens: 10_000,
        reasoning: { defaultEffort: 'max', efforts: ['max'] },
      }],
    }))
    const adapter = new BailianAdapter({
      profiles: () => new Map([[BAILIAN_PROVIDER_ID, profile]]),
      resolveApiKey: async () => 'test-key',
    })
    await consume(adapter.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'private-deployment-v7',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      })],
    }))
    expect(requests[0]).toMatchObject({
      model: 'private-deployment-v7',
      reasoning_effort: 'max',
      enable_thinking: true,
    })
  })

  it('uses Qwen enable_thinking and thinking_budget without DeepSeek parameters', async () => {
    const requests: WireRequest[] = []
    const baseURL = await endpoint(requests)
    const profile = createBailianProfile(resolveBailianConfig({
      baseURL,
      models: [qwenModel(8_192)],
    }))
    const profiles = new Map([[BAILIAN_PROVIDER_ID, profile]])
    const adapter = new BailianAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'test-key',
    })
    await consume(adapter.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'qwen3.7-plus',
      reasoningEffort: ReasoningEffortId('high'),
      system: 'system prompt',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      })],
    }))
    expect(requests[0]).toMatchObject({
      model: 'qwen3.7-plus',
      enable_thinking: true,
      thinking_budget: 8_192,
    })
    expect(requests[0]?.reasoning_effort).toBeUndefined()
    expect(requests[0]?.messages?.[0]?.role).toBe('system')
  })
})
