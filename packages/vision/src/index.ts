import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  BlockAssembler,
  createUserMessage,
  type ContentBlock,
  type LlmFailure,
} from '@deepseek-ai/dsh-llm'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { VisionConfigSchema } from './config.ts'
import {
  VISION_SYSTEM_PROMPT,
  visionInferenceContent,
  sanitizeObservation,
  wrapToolObservation,
} from './observation.ts'
import { createInspectImageTool } from './tool.ts'
import type {
  ResolvedImageRoute,
  ResolvedProxyImageRoute,
  VisionAnalysis,
  VisionConfig,
  VisionImageInput,
  VisionInspection,
  VisionRequest,
  VisionResultMetadata,
  VisionStatus,
} from './types.ts'

export { VisionConfigSchema as Config }
export type {
  ResolvedImageRoute,
  ResolvedProxyImageRoute,
  VisionAnalysis,
  VisionConfig,
  VisionImageInput,
  VisionInspection,
  VisionMode,
  VisionRequest,
  VisionResultMetadata,
  VisionStatus,
  VisionUnavailableReason,
} from './types.ts'

const PLUGIN_NAME = 'community-vision'
const VISION_NAMESPACE = 'vision'

declare module '@deepseek-ai/cordis' {
  interface Context {
    vision: VisionService
  }
}

export class VisionError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VisionError'
  }
}

function safeErrorMessage(value: string): string {
  const clean = value
    .replaceAll(new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, 'gu'), '')
    .replaceAll(/\p{Cc}/gu, character => character === '\n' || character === '\t' ? character : '')
    .trim()
  return clean.length <= 500 ? clean : `${clean.slice(0, 499)}…`
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
}

interface VisionInference extends VisionResultMetadata {
  rawObservation: string
}

/** Proxy image analysis and inspection built on official media services. */
export class VisionService extends Service {
  static inject = ['attachments', 'fs', 'llm', 'settings', 'tools']
  static Config = VisionConfigSchema

  private readonly settings: SettingsScope<VisionConfig>

  constructor(ctx: Context, config: VisionConfig) {
    super(ctx, 'vision')
    this.settings = ctx.settings.register(VISION_NAMESPACE, VisionConfigSchema, { base: config, applies: 'live' })
    ctx.tools.register(createInspectImageTool({
      attachments: ctx.attachments,
      fs: ctx.fs,
      observe: (target, observation, actor) => ctx.emit('fs/observed', target, observation, actor),
      resolveRoute: exec => this.resolveToolRoute(exec),
      inspect: (attachment, userText, route, signal) => this.inspectAttachment(attachment, userText, route, signal),
    }))
  }

  get config(): VisionConfig {
    return this.settings.get()
  }

  /** Resolve only the configured proxy; callers own native image submission. */
  async resolveProxyRoute(
    signal?: AbortSignal,
  ): Promise<ResolvedProxyImageRoute | Extract<ResolvedImageRoute, { strategy: 'disabled' }>> {
    signal?.throwIfAborted()
    const config = this.config
    if (config.mode === 'disabled') {
      return { strategy: 'disabled', reason: 'disabled', message: 'Vision proxy is disabled. Open /config Vision to enable it.' }
    }
    const proxy = await this.ctx.llm.resolveModelInfo(config.proxyProvider, config.proxyModel, signal)
      .catch(() => undefined)
    signal?.throwIfAborted()
    if (proxy === undefined) {
      return {
        strategy: 'disabled',
        reason: 'proxy-unavailable',
        message: `Vision proxy ${config.proxyProvider}/${config.proxyModel} is unavailable. Open /config Vision to configure it.`,
      }
    }
    if (!proxy.inputModalities?.includes('image')) {
      return {
        strategy: 'disabled',
        reason: 'proxy-does-not-support-images',
        message: `Vision proxy ${config.proxyProvider}/${config.proxyModel} does not declare image input support.`,
      }
    }
    return {
      strategy: 'proxy',
      provider: proxy.provider,
      model: proxy.id,
      maxObservationChars: config.maxObservationChars,
      maxTokens: config.maxTokens,
    }
  }

  async status(signal?: AbortSignal): Promise<VisionStatus> {
    const config = this.config
    const proxy = await this.ctx.llm.resolveModelInfo(config.proxyProvider, config.proxyModel, signal)
      .catch(() => undefined)
    signal?.throwIfAborted()
    return {
      config,
      proxyRegistered: proxy !== undefined,
      proxySupportsImages: proxy?.inputModalities?.includes('image') ?? false,
    }
  }

  async setMode(mode: VisionConfig['mode']): Promise<void> {
    await this.settings.update({ mode })
  }

  async analyze(
    route: ResolvedProxyImageRoute,
    request: VisionRequest,
    signal?: AbortSignal,
  ): Promise<VisionAnalysis> {
    this.assertImages(request.images)
    this.assertReferences(request.images)
    const startedAt = Date.now()
    signal?.throwIfAborted()
    const saved = await this.ctx.attachments.saveImages(request.images.map(image => ({
      data: image.data,
      mediaType: image.mediaType,
      ...image.name === undefined ? {} : { name: image.name },
    })))
    signal?.throwIfAborted()
    const { rawObservation, ...inference } = await this.runInference(
      request.userText,
      saved.map((attachment, index) => ({
        attachment,
        reference: request.images[index]!.reference,
      })),
      route,
      startedAt,
      signal,
    )
    const observation = sanitizeObservation(rawObservation, route.maxObservationChars)
    return {
      analysisId: request.analysisId,
      ...inference,
      observation: observation.text,
      references: request.images.map(image => image.reference),
      truncated: inference.truncated || observation.truncated,
    }
  }

  /** Inspect one verified attachment without creating another durable object or user Prompt. */
  private async inspectAttachment(
    attachment: ImageAttachmentRef,
    userText: string,
    route: ResolvedProxyImageRoute,
    signal?: AbortSignal,
  ): Promise<VisionInspection> {
    const { rawObservation, ...inference } = await this.runInference(
      userText,
      [{ reference: '[Image #1]', attachment }],
      route,
      Date.now(),
      signal,
    )
    const wrapped = wrapToolObservation(
      rawObservation,
      inference.provider,
      inference.model,
      route.maxObservationChars,
    )
    return {
      ...inference,
      observation: wrapped.text,
      truncated: inference.truncated || wrapped.truncated,
    }
  }

  private async runInference(
    userText: string,
    images: readonly { reference: string; attachment: ImageAttachmentRef }[],
    route: ResolvedProxyImageRoute,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<VisionInference> {
    const assembler = new BlockAssembler()
    const content = visionInferenceContent(userText, images)
    for await (const chunk of this.ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: VISION_SYSTEM_PROMPT,
      messages: [createUserMessage({ content, source: { kind: 'plugin', plugin: PLUGIN_NAME } })],
      maxTokens: route.maxTokens,
      ...signal === undefined ? {} : { signal },
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw this.failureError(finish.failure)
    const raw = textOf(assembler.blocks())
    if (raw === '') throw new VisionError('EMPTY_OBSERVATION', 'The Vision model returned no readable observation.')
    const durationMs = Date.now() - startedAt
    return {
      provider: route.provider,
      model: route.model,
      rawObservation: raw,
      attachments: images.map(image => image.attachment),
      durationMs,
      finishReason: finish.kind,
      truncated: finish.kind === 'max-tokens',
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
  }

  private assertImages(images: readonly VisionImageInput[]): void {
    if (images.length === 0) throw new VisionError('NO_IMAGES', 'Vision analysis requires at least one image.')
  }

  private assertReferences(images: readonly VisionImageInput[]): void {
    const references = new Set<string>()
    for (const image of images) {
      const reference = image.reference
      if (reference.trim() === '') {
        throw new VisionError('INVALID_IMAGE_REFERENCE', 'Vision image references must not be empty.')
      }
      if (references.has(reference)) {
        throw new VisionError('INVALID_IMAGE_REFERENCE', `Vision image reference is duplicated: ${reference}`)
      }
      references.add(reference)
    }
  }

  private failureError(failure: LlmFailure): VisionError {
    return new VisionError(failure.code, safeErrorMessage(failure.message))
  }

  private async resolveToolRoute(exec: ToolRunContext): Promise<ResolvedImageRoute> {
    exec.signal.throwIfAborted()
    if (this.config.mode !== 'proxy') {
      const request = exec.agent?.session.requestHeader()?.config
      const provider = request?.provider ?? exec.agent?.options.provider
      const model = request?.model ?? exec.agent?.options.model
      if (provider === undefined || model === undefined) {
        throw new VisionError('MODEL_ROUTE_UNAVAILABLE', 'inspect_image could not resolve the current model route.')
      }
      const main = await this.ctx.llm.resolveModelInfo(provider, model, exec.signal).catch(() => undefined)
      exec.signal.throwIfAborted()
      if (main?.inputModalities?.includes('image')) {
        return { strategy: 'native', provider: main.provider, model: main.id }
      }
    }
    return this.resolveProxyRoute(exec.signal)
  }
}

export default VisionService
