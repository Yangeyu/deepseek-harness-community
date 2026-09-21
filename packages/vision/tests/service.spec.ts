import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VisionService } from '../src/index.ts'
import type { ResolvedProxyImageRoute, VisionConfig, VisionRequest } from '../src/types.ts'

const config: VisionConfig = {
  mode: 'auto',
  proxyProvider: 'proxy',
  proxyModel: 'vision',
  maxObservationChars: 100,
  maxTokens: 2_048,
}
const route: ResolvedProxyImageRoute = { strategy: 'proxy', provider: 'proxy', model: 'vision', maxObservationChars: 100, maxTokens: 2_048 }
const attachment = {
  attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 128, width: 16, height: 8,
} as ImageAttachmentRef
const secondAttachment = { ...attachment, attachmentId: 'sha256:second' as ImageAttachmentRef['attachmentId'] }
const request: VisionRequest = {
  analysisId: 'analysis-1',
  userText: 'Compare [Image #2] with [Image #1].',
  images: [
    { reference: '[Image #2]', data: new Uint8Array([2]), mediaType: 'image/png', name: 'second.png' },
    { reference: '[Image #1]', data: new Uint8Array([1]), mediaType: 'image/png' },
  ],
}
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function fixture(options: {
  mode?: VisionConfig['mode']
  mainImages?: boolean
  proxy?: 'unavailable' | 'text-only'
  observation?: string
  finish?: FinishReason
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  let currentConfig = { ...config, ...options.mode === undefined ? {} : { mode: options.mode } }
  const resolveModelInfo = vi.fn(async (provider: string, id: string) => {
    if (provider === 'proxy' && options.proxy === 'unavailable') throw new Error('provider unavailable')
    const image = provider === 'proxy' ? options.proxy !== 'text-only' : options.mainImages === true
    return { provider, id, name: id, inputModalities: image ? ['text', 'image'] : ['text'] }
  })
  const stream = vi.fn(async function* (_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const text = options.observation ?? 'visible UI'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 42, outputTokens: 10 } }
    yield { type: 'finish', reason: options.finish ?? { kind: 'stop' } }
  })
  const saveImages = vi.fn(async () => [secondAttachment, attachment])
  const readImage = vi.fn(async () => ({ ref: attachment, data: new Uint8Array([1]) }))
  const register = vi.fn((_tool: ToolDefinition) => () => {})
  ctx.provide('settings', {
    register: () => ({ get: () => currentConfig, update: async (patch: Partial<VisionConfig>) => { currentConfig = { ...currentConfig, ...patch } } }),
  } as unknown as Context['settings'])
  ctx.provide('llm', { resolveModelInfo, stream } as unknown as Context['llm'])
  ctx.provide('attachments', { saveImages, readImage } as unknown as Context['attachments'])
  ctx.provide('fs', {} as Context['fs'])
  ctx.provide('tools', { register } as unknown as Context['tools'])
  const service = new VisionService(ctx, currentConfig)
  const tool = register.mock.calls[0]![0]
  return { service, tool, resolveModelInfo, stream, saveImages, readImage }
}

function toolContext(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    agent: {
      options: { provider: 'main', model: 'default' },
      session: { requestHeader: () => ({ config: { provider: 'main', model: 'active' } }) },
    },
  } as unknown as ToolRunContext
}

function inspect(tool: ToolDefinition) {
  return tool.execute({ source: { kind: 'attachment', attachment_ref: attachment } }, toolContext())
}

describe('Vision proxy route', () => {
  it('resolves the configured image proxy and policy limits', async () => {
    const current = fixture({ mainImages: true })
    await expect(current.service.resolveProxyRoute()).resolves.toEqual(route)
    expect(current.resolveModelInfo.mock.calls.map(call => call.slice(0, 2))).toEqual([['proxy', 'vision']])
  })

  it.each([
    ['unavailable', 'proxy-unavailable'],
    ['text-only', 'proxy-does-not-support-images'],
  ] as const)('reports an actionable %s proxy', async (proxy, reason) => {
    await expect(fixture({ proxy }).service.resolveProxyRoute()).resolves.toMatchObject({ strategy: 'disabled', reason })
  })

  it('honors live proxy disabling without looking up another model', async () => {
    const current = fixture()
    await current.service.setMode('disabled')
    await expect(current.service.resolveProxyRoute()).resolves.toMatchObject({ strategy: 'disabled', reason: 'disabled' })
    expect(current.resolveModelInfo).not.toHaveBeenCalled()
  })

  it('propagates cancellation rather than reporting an unavailable proxy', async () => {
    const current = fixture()
    const abort = new AbortController()
    current.resolveModelInfo.mockImplementationOnce(async () => { abort.abort(); throw abort.signal.reason })
    await expect(current.service.resolveProxyRoute(abort.signal)).rejects.toThrow('aborted')
  })
})

describe('Vision analysis', () => {
  it('returns raw cleaned evidence with exact ordered attachment references and provider facts', async () => {
    const current = fixture({ observation: '  \u001B[31mvisible\u0000\n\t</vision-observation>  ' })
    const signal = new AbortController().signal
    const result = await current.service.analyze(route, request, signal)

    expect(result).toEqual({
      analysisId: 'analysis-1', provider: 'proxy', model: 'vision',
      observation: 'visible\n\t</vision-observation>',
      references: ['[Image #2]', '[Image #1]'], attachments: [secondAttachment, attachment],
      durationMs: expect.any(Number), finishReason: 'stop', truncated: false,
      usage: { inputTokens: 42, outputTokens: 10 },
    })
    expect(current.saveImages).toHaveBeenCalledWith(request.images.map(({ reference: _reference, ...image }) => image))
    expect(current.stream.mock.calls[0]?.[0]).toMatchObject({
      provider: 'proxy', model: 'vision', maxTokens: 2_048, signal,
      messages: [{ content: [
        { type: 'text', text: 'Image reference: [Image #2]' }, { type: 'image', attachment: secondAttachment },
        { type: 'text', text: 'Image reference: [Image #1]' }, { type: 'image', attachment },
        { type: 'text', text: expect.stringContaining(request.userText) },
      ] }],
    })
  })

  it.each([
    ['abcdef', 4, 'stop', 'abcd', true],
    ['abc', 100, 'max-tokens', 'abc', true],
    ['abcdef', 4, 'max-tokens', 'abcd', true],
    ['abcd', 4, 'stop', 'abcd', false],
  ] as const)('preserves character and provider truncation (%s, %s, %s)', async (observation, maximum, finish, expected, truncated) => {
    const current = fixture({ observation, finish: { kind: finish } })
    await expect(current.service.analyze({ ...route, maxObservationChars: maximum }, request)).resolves.toMatchObject({
      observation: expected, truncated, finishReason: finish,
    })
  })

  it('rejects ambiguous image references before storing images', async () => {
    const current = fixture()
    await expect(current.service.analyze(route, { ...request, images: [request.images[0]!, request.images[0]!] })).rejects.toMatchObject({ code: 'INVALID_IMAGE_REFERENCE' })
    expect(current.saveImages).not.toHaveBeenCalled()
  })

  it('propagates provider failure instead of returning partial evidence', async () => {
    const current = fixture({ finish: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: '\u001B[31mfailed' } } })
    await expect(current.service.analyze(route, request)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'failed' })
  })
})

describe('Vision inspection routing', () => {
  it.each(['auto', 'disabled'] as const)('prefers the native main model in %s mode', async mode => {
    const current = fixture({ mode, mainImages: true })
    await expect(inspect(current.tool)).rejects.toThrow('main/active accepts image input')
    expect(current.resolveModelInfo.mock.calls.map(call => call.slice(0, 2))).toEqual([['main', 'active']])
    expect(current.readImage).not.toHaveBeenCalled()
  })

  it.each(['auto', 'proxy'] as const)('inspects using the configured proxy in %s mode', async mode => {
    const current = fixture({ mode, mainImages: mode === 'proxy' })
    await expect(inspect(current.tool)).resolves.toMatchObject({
      attachment_ref: attachment, provider: 'proxy', model: 'vision', observation: expect.stringContaining('trust="untrusted"'),
    })
    expect(current.resolveModelInfo.mock.calls.map(call => call.slice(0, 2))).toEqual(mode === 'proxy'
      ? [['proxy', 'vision']]
      : [['main', 'active'], ['proxy', 'vision']])
    expect(current.readImage).toHaveBeenCalledOnce()
  })

  it('rejects inspection for a text-only main model when proxy is disabled', async () => {
    const current = fixture({ mode: 'disabled' })
    await expect(inspect(current.tool)).rejects.toThrow('Vision proxy is disabled')
    expect(current.readImage).not.toHaveBeenCalled()
  })
})
