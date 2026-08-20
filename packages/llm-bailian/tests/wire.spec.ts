import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  BailianAdapter,
  BAILIAN_PROVIDER_ID,
  resolveBailianConfig,
  type BailianModelConfig,
} from '../src/index.ts'

interface CapturedRequest {
  body: Record<string, unknown>
  headers: IncomingHttpHeaders
  url: string | undefined
}

const servers: Server[] = []

type Reply = (response: ServerResponse) => void

function writeSse(response: ServerResponse, payloads: readonly (string | object)[], end = true): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(payloads.map(payload => (
    `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
  )).join(''))
  if (end) response.end()
}

const successfulReply: Reply = response => {
  writeSse(response, [
    { choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
    },
    '[DONE]',
  ])
}

function deepseekModel(): BailianModelConfig {
  return {
    contextWindow: 1_000_000,
    maxOutputTokens: 393_216,
    maxTokensField: 'max_tokens',
    input: ['text'],
    reasoning: {
      defaultEffort: 'high',
      efforts: {
        off: { enableThinking: false },
        low: { enableThinking: true, reasoningEffort: 'low' },
        high: { enableThinking: true, reasoningEffort: 'high' },
        max: { enableThinking: true, reasoningEffort: 'max' },
      },
    },
  }
}

function qwenModel(): BailianModelConfig {
  return {
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    maxTokensField: 'max_completion_tokens',
    input: ['text', 'image'],
    reasoning: {
      defaultEffort: 'high',
      efforts: {
        off: { enableThinking: false },
        high: { enableThinking: true, thinkingBudget: 8_192 },
      },
    },
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })))
})

async function endpoint(requests: CapturedRequest[], reply: Reply = successfulReply): Promise<string> {
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk.toString()
    requests.push({ body: JSON.parse(raw) as Record<string, unknown>, headers: request.headers, url: request.url })
    reply(response)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

async function consume(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function adapter(
  baseURL: string,
  models: Record<string, BailianModelConfig>,
  attachments?: AttachmentStore,
  streamIdleTimeoutMs?: number,
): BailianAdapter {
  const config = resolveBailianConfig({
    baseURL,
    models,
    ...streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs },
  })
  return new BailianAdapter({
    options: () => config,
    resolveApiKey: async () => 'test-key',
    ...attachments === undefined ? {} : { resolveAttachments: () => attachments },
  })
}

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('Bailian wire contract', () => {
  it('sends explicit DeepSeek reasoning and max_tokens policy', async () => {
    const requests: CapturedRequest[] = []
    const client = adapter(await endpoint(requests), { 'deepseek-v4-pro-0813': deepseekModel() })
    const chunks = await consume(client.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'deepseek-v4-pro-0813',
      reasoningEffort: ReasoningEffortId('max'),
      system: 'system prompt',
      messages: [user('hello')],
      maxTokens: 123,
      stop: ['END'],
    }))

    expect(requests[0]?.url).toBe('/chat/completions')
    expect(requests[0]?.body).toMatchObject({
      model: 'deepseek-v4-pro-0813',
      enable_thinking: true,
      reasoning_effort: 'max',
      max_tokens: 123,
      stop: ['END'],
    })
    expect(requests[0]?.body).not.toHaveProperty('max_completion_tokens')
    expect(requests[0]?.body).not.toHaveProperty('store')
    expect(requests[0]?.headers.authorization).toBe('Bearer test-key')
    expect(requests[0]?.headers['user-agent']).toBeTruthy()
    expect(requests[0]?.body.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.findIndex(chunk => chunk.type === 'usage')).toBeLessThan(chunks.findIndex(chunk => chunk.type === 'finish'))
  })

  it('uses the configured default and disables reasoning for off', async () => {
    const requests: CapturedRequest[] = []
    const client = adapter(await endpoint(requests), { custom: deepseekModel() })
    await consume(client.stream({ provider: BAILIAN_PROVIDER_ID, model: 'custom', messages: [user('one')] }))
    await consume(client.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'custom',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [user('two')],
    }))
    expect(requests[0]?.body).toMatchObject({ enable_thinking: true, reasoning_effort: 'high' })
    expect(requests[1]?.body).toMatchObject({ enable_thinking: false })
    expect(requests[1]?.body).not.toHaveProperty('reasoning_effort')
  })

  it('preserves interleaved Qwen image references and content order', async () => {
    const requests: CapturedRequest[] = []
    const firstRef: ImageAttachmentRef = {
      attachmentId: AttachmentId('image-1'),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const secondRef: ImageAttachmentRef = {
      ...firstRef,
      attachmentId: AttachmentId('image-2'),
    }
    const attachments = {
      readImage: async (ref: ImageAttachmentRef) => ({
        ref,
        data: Uint8Array.from([String(ref.attachmentId) === 'image-1' ? 1 : 2]),
      }),
    } as unknown as AttachmentStore
    const client = adapter(await endpoint(requests), { 'qwen3.7-plus': qwenModel() }, attachments)
    await consume(client.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'qwen3.7-plus',
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'before [Image #2]' },
          { type: 'image', attachment: secondRef },
          { type: 'text', text: ' between [Image #1]' },
          { type: 'image', attachment: firstRef },
          { type: 'text', text: ' after' },
        ],
        source: { kind: 'user' },
      })],
      maxTokens: 2_048,
    }))
    expect(requests[0]?.body).toMatchObject({
      enable_thinking: true,
      thinking_budget: 8_192,
      max_completion_tokens: 2_048,
    })
    expect(requests[0]?.body).not.toHaveProperty('reasoning_effort')
    expect(requests[0]?.body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'before [Image #2]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,Ag==' } },
        { type: 'text', text: ' between [Image #1]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
        { type: 'text', text: ' after' },
      ],
    }])
  })

  it('does not send a token field when no request default exists', async () => {
    const requests: CapturedRequest[] = []
    const client = adapter(await endpoint(requests), { custom: deepseekModel() })
    await consume(client.stream({ provider: BAILIAN_PROVIDER_ID, model: 'custom', messages: [user('hello')] }))
    expect(requests[0]?.body).not.toHaveProperty('max_tokens')
    expect(requests[0]?.body).not.toHaveProperty('max_completion_tokens')
  })

  it('reassembles fragmented and parallel tool calls', async () => {
    const requests: CapturedRequest[] = []
    const client = adapter(await endpoint(requests, response => {
      writeSse(response, [
        {
          choices: [{
            delta: {
              tool_calls: [
                { index: 0, id: 'call-a', function: { name: 'first', arguments: '{"value"' } },
                { index: 1, id: 'call-b', function: { name: 'second', arguments: '' } },
              ],
            },
          }],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { arguments: ':1}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: '', function: { arguments: '{}' } }] } }] },
        {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        },
        '[DONE]',
      ])
    }), { custom: deepseekModel() })

    const chunks = await consume(client.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'custom',
      messages: [user('use tools')],
    }))

    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.id)).toEqual([
      'call-a',
      'call-b',
      'call-a',
      'call-b',
    ])
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call-a', name: 'first', arguments: '{"value":1}' },
      },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 'call-b', name: 'second', arguments: '{}' },
      },
    ])
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 8, outputTokens: 4 },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('buffers tool arguments until a non-empty id arrives and rejects a permanently missing id', async () => {
    const requests: CapturedRequest[] = []
    const delayed = adapter(await endpoint(requests, response => {
      writeSse(response, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { name: 'read', arguments: '{"path"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-delayed', function: { arguments: ':"README.md"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ])
    }), { custom: deepseekModel() })

    const chunks = await consume(delayed.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'custom',
      messages: [user('read')],
    }))
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta')).toEqual([{
      type: 'tool-call-delta',
      index: 0,
      id: 'call-delayed',
      name: 'read',
      argumentsDelta: '{"path":"README.md"}',
    }])

    const missingRequests: CapturedRequest[] = []
    const missing = adapter(await endpoint(missingRequests, response => {
      writeSse(response, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { name: 'read', arguments: '{}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ])
    }), { custom: deepseekModel() })
    await expect(consume(missing.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'custom',
      messages: [user('read')],
    }))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('retains HTTP retry and request metadata in provider failures', async () => {
    const requests: CapturedRequest[] = []
    const client = adapter(await endpoint(requests, response => {
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '2',
        'x-request-id': 'request-123',
      })
      response.end(JSON.stringify({ error: { code: 'Throttling', message: 'slow down' } }))
    }), { custom: deepseekModel() })

    await expect(consume(client.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'custom',
      messages: [user('hello')],
    }))).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      failure: {
        message: 'slow down',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 2_000,
        requestId: 'request-123',
      },
    })
  })

  it.each([
    ['malformed JSON', (response: ServerResponse) => writeSse(response, ['{bad json']) , 'MALFORMED_RESPONSE'],
    ['missing DONE', (response: ServerResponse) => writeSse(response, [
      { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
    ]), 'STREAM_CLOSED'],
  ] as const)('classifies %s stream failures', async (_label, reply, code) => {
    const requests: CapturedRequest[] = []
    const client = adapter(await endpoint(requests, reply), { custom: deepseekModel() })
    await expect(consume(client.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'custom',
      messages: [user('hello')],
    }))).rejects.toMatchObject({ code })
  })

  it('distinguishes caller cancellation from provider idle timeout', async () => {
    const cancelledRequests: CapturedRequest[] = []
    const controller = new AbortController()
    const cancelled = adapter(await endpoint(cancelledRequests, response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      setTimeout(() => controller.abort('test cancellation'), 10)
    }), { custom: deepseekModel() })
    await expect(consume(cancelled.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'custom',
      messages: [user('cancel')],
      signal: controller.signal,
    }))).rejects.toMatchObject({ code: 'ABORTED' })

    const timedOutRequests: CapturedRequest[] = []
    const timedOut = adapter(await endpoint(timedOutRequests, response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
    }), { custom: deepseekModel() }, undefined, 20)
    await expect(consume(timedOut.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'custom',
      messages: [user('timeout')],
    }))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('serializes multiple tool results with images in correct order', async () => {
    const requests: CapturedRequest[] = []
    const imageRef1: ImageAttachmentRef = {
      attachmentId: AttachmentId('image-1'),
      mediaType: 'image/png',
      bytes: 1,
      width: 100,
      height: 100,
    }
    const imageRef2: ImageAttachmentRef = {
      attachmentId: AttachmentId('image-2'),
      mediaType: 'image/png',
      bytes: 2,
      width: 200,
      height: 200,
    }
    const imageRef3: ImageAttachmentRef = {
      attachmentId: AttachmentId('image-3'),
      mediaType: 'image/png',
      bytes: 3,
      width: 300,
      height: 300,
    }
    const attachments = {
      readImage: async (ref: ImageAttachmentRef) => ({
        ref,
        data: Uint8Array.from([Number(String(ref.attachmentId).split('-')[1])]),
      }),
    } as unknown as AttachmentStore
    const client = adapter(await endpoint(requests), { 'qwen3.7-plus': qwenModel() }, attachments)

    // Simulate an assistant message with 3 tool calls followed by their results
    const messages = [
      createAssistantMessage({
        content: [
          { type: 'tool-call' as const, id: CallId('call-1'), name: 'read_image', arguments: '{"file":"img1.png"}' },
          { type: 'tool-call' as const, id: CallId('call-2'), name: 'read_image', arguments: '{"file":"img2.png"}' },
          { type: 'tool-call' as const, id: CallId('call-3'), name: 'read_image', arguments: '{"file":"img3.png"}' },
        ],
        source: { provider: 'test', model: 'test' },
      }),
      createToolResultMessage({
        callId: CallId('call-1'),
        content: [
          { type: 'text' as const, text: 'Image 1 data' },
          { type: 'image' as const, attachment: imageRef1 },
        ],
        isError: false,
      }),
      createToolResultMessage({
        callId: CallId('call-2'),
        content: [
          { type: 'text' as const, text: 'Image 2 data' },
          { type: 'image' as const, attachment: imageRef2 },
        ],
        isError: false,
      }),
      createToolResultMessage({
        callId: CallId('call-3'),
        content: [
          { type: 'text' as const, text: 'Image 3 data' },
          { type: 'image' as const, attachment: imageRef3 },
        ],
        isError: false,
      }),
    ]

    await consume(client.stream({
      provider: BAILIAN_PROVIDER_ID,
      model: 'qwen3.7-plus',
      messages,
    }))

    // Verify that all tool messages come before any user messages with images
    const sentMessages = requests[0]?.body.messages as Array<Record<string, unknown>>
    expect(sentMessages).toBeDefined()
    
    // Find indices of tool and user messages
    const toolIndices: number[] = []
    const userWithImageIndices: number[] = []
    
    sentMessages.forEach((msg, idx) => {
      if (msg.role === 'tool') {
        toolIndices.push(idx)
      } else if (msg.role === 'user' && Array.isArray(msg.content) && 
                 (msg.content as Array<Record<string, unknown>>).some(part => part.type === 'image_url')) {
        userWithImageIndices.push(idx)
      }
    })

    // All tool messages should come before any user messages with images
    expect(toolIndices.length).toBe(3)
    expect(userWithImageIndices.length).toBe(3)
    expect(Math.max(...toolIndices)).toBeLessThan(Math.min(...userWithImageIndices))

    // Verify tool_call_ids are correct
    expect(sentMessages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
    expect(sentMessages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-2' })
    expect(sentMessages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call-3' })
  })
})
