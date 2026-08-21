import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  BlockAssembler,
  createUserMessage,
  type ContentBlock,
  type LlmFailure,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { VisionConfigSchema } from './config.ts'
import {
  VISION_SYSTEM_PROMPT,
  visionImageReference,
  visionInferenceContent,
  wrapObservation,
  wrapToolObservation,
} from './observation.ts'
import { chooseVisionRoute } from './routing.ts'
import { VisionObservationStage } from './events.ts'
import { createInspectImageTool } from './tool.ts'
import type {
  VisionAdmissionRequest,
  VisionAnalysis,
  VisionCapability,
  VisionConfig,
  VisionEvidenceMetadata,
  VisionEvidenceSource,
  VisionImageInput,
  VisionInspection,
  VisionObservationBlock,
  VisionRequest,
  VisionResultMetadata,
  VisionStatus,
  VisionSubmissionSource,
} from './types.ts'

export { VisionConfigSchema as Config }
export { chooseVisionRoute } from './routing.ts'
export { detectImageMediaType, imageDimensions } from './image.ts'
export { VISION_SYSTEM_PROMPT, visionUserPrompt, wrapObservation, wrapToolObservation } from './observation.ts'
export type {
  VisionAdmissionRequest,
  VisionAnalysis,
  VisionCapability,
  VisionConfig,
  VisionEvidenceMetadata,
  VisionEvidenceSource,
  VisionImageInput,
  VisionInspection,
  VisionMode,
  VisionObservationBlock,
  VisionReferencedImageInput,
  VisionRequest,
  VisionResultMetadata,
  VisionStatus,
  VisionUnavailableReason,
} from './types.ts'

const PLUGIN_NAME = 'community-vision'
const VISION_NAMESPACE = settingsNamespace('vision')

declare module '@deepseek-ai/cordis' {
  interface Context {
    vision: VisionService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'community-vision-observation': VisionObservationBlock
  }

  interface MessageSourceMap {
    'community-vision': VisionEvidenceSource
    'community-vision-submission': VisionSubmissionSource
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

/** Host-owned Vision policy, proxy analysis, and staged evidence service. */
export class VisionService extends Service {
  static inject = ['agents', 'attachments', 'fs', 'llm', 'settings', 'tools']
  static Config = VisionConfigSchema

  private readonly settings: SettingsScope<VisionConfig>
  private readonly observations: VisionObservationStage

  constructor(ctx: Context, config: VisionConfig) {
    super(ctx, 'vision')
    this.settings = ctx.settings.register(VISION_NAMESPACE, VisionConfigSchema, { base: config, applies: 'live' })
    this.observations = new VisionObservationStage(ctx)
    ctx.tools.register(createInspectImageTool({
      attachments: ctx.attachments,
      fs: ctx.fs,
      observe: (target, observation, actor) => ctx.emit('fs/observed', target, observation, actor),
      inspect: (attachment, userText, signal) => this.inspectAttachment(attachment, userText, signal),
    }))
  }

  get config(): VisionConfig {
    return this.settings.get()
  }

  newAnalysisId(): string {
    return randomUUID()
  }

  async supportsNativeImages(provider: string, model: string, signal?: AbortSignal): Promise<boolean> {
    const info = await this.ctx.llm.resolveModelInfo(provider, model, signal).catch(() => undefined)
    signal?.throwIfAborted()
    return info?.inputModalities?.includes('image') ?? false
  }

  async capability(provider: string, model: string, signal?: AbortSignal): Promise<VisionCapability> {
    const config = this.config
    if (config.mode === 'disabled') return chooseVisionRoute(config, undefined, undefined)
    const [main, proxy] = await Promise.all([
      this.ctx.llm.resolveModelInfo(provider, model, signal).catch(() => undefined),
      this.ctx.llm.resolveModelInfo(config.proxyProvider, config.proxyModel, signal).catch(() => undefined),
    ])
    signal?.throwIfAborted()
    return chooseVisionRoute(config, main, proxy)
  }

  async status(signal?: AbortSignal): Promise<VisionStatus> {
    return this.resolveStatus(this.config, signal)
  }

  private async resolveStatus(config: VisionConfig, signal?: AbortSignal): Promise<VisionStatus> {
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

  discard(analysisId: string): void {
    this.observations.discard(analysisId)
  }

  admit(request: VisionAdmissionRequest): void {
    const agent = this.ctx.agents.get(SessionId(request.sessionId))
    if (agent === undefined) throw new VisionError('SESSION_UNAVAILABLE', 'The active session is no longer available.')
    const message = this.observations.submission(request)
    if (request.mode === 'steer') agent.steer(message)
    else agent.followup(message)
    this.observations.discard(request.analysisId)
  }

  async analyze(request: VisionRequest, signal?: AbortSignal): Promise<VisionAnalysis> {
    this.assertImages(request.images)
    this.assertReferences(request.images)
    if (this.ctx.agents.get(SessionId(request.sessionId)) === undefined) {
      throw new VisionError('SESSION_UNAVAILABLE', 'The active session is no longer available.')
    }
    const config = this.config
    const route = await this.resolveProxyRoute(config, signal)
    const startedAt = Date.now()
    signal?.throwIfAborted()
    const saved = await this.ctx.attachments.saveImages(request.images.map(image => ({
      data: image.data,
      mediaType: image.mediaType,
      ...image.name === undefined ? {} : { name: image.name },
    })))
    if (saved.length !== request.images.length) {
      throw new VisionError('ATTACHMENT_MISMATCH', 'Vision attachment storage did not preserve the submitted image set.')
    }
    signal?.throwIfAborted()
    const { rawObservation, ...inference } = await this.runInference(
      request.userText,
      saved.map((attachment, index) => ({
        attachment,
        reference: visionImageReference(request.images[index]!, index),
      })),
      route,
      config,
      startedAt,
      signal,
    )
    const wrapped = wrapObservation(
      rawObservation,
      inference.provider,
      inference.model,
      config.maxObservationChars,
      inference.attachments.map((attachment, index) => ({
        attachment,
        reference: visionImageReference(request.images[index]!, index),
      })),
    )
    const truncated = inference.truncated || wrapped.truncated
    const source: VisionEvidenceMetadata = {
      analysisId: request.analysisId,
      ...inference,
      truncated,
    }
    this.observations.set(request.analysisId, {
      sessionId: request.sessionId,
      observation: wrapped.text,
      source,
    })
    return {
      analysisId: request.analysisId,
      ...inference,
      observation: wrapped.text,
      truncated,
    }
  }

  /** Inspect one verified attachment without creating another durable object or user Prompt. */
  private async inspectAttachment(
    attachment: ImageAttachmentRef,
    userText: string,
    signal?: AbortSignal,
  ): Promise<VisionInspection> {
    const config = this.config
    const route = await this.resolveProxyRoute(config, signal)
    const { rawObservation, ...inference } = await this.runInference(
      userText,
      [{ reference: '[Image #1]', attachment }],
      route,
      config,
      Date.now(),
      signal,
    )
    const wrapped = wrapToolObservation(
      rawObservation,
      inference.provider,
      inference.model,
      config.maxObservationChars,
    )
    return {
      ...inference,
      observation: wrapped.text,
      truncated: inference.truncated || wrapped.truncated,
    }
  }

  private async resolveProxyRoute(
    config: VisionConfig,
    signal?: AbortSignal,
  ): Promise<{ provider: string; model: string }> {
    if (config.mode === 'disabled') throw new VisionError('VISION_DISABLED', 'Vision is disabled. Open /config vision to enable it.')
    const info = await this.ctx.llm.resolveModelInfo(config.proxyProvider, config.proxyModel, signal)
      .catch(() => undefined)
    signal?.throwIfAborted()
    if (info === undefined) {
      throw new VisionError('PROXY_UNAVAILABLE', `Vision proxy ${config.proxyProvider}/${config.proxyModel} is unavailable.`)
    }
    if (!info.inputModalities?.includes('image')) {
      throw new VisionError('PROXY_NOT_MULTIMODAL', `Vision proxy ${info.provider}/${info.id} does not declare image input support.`)
    }
    return { provider: info.provider, model: info.id }
  }

  private async runInference(
    userText: string,
    images: readonly { reference: string; attachment: ImageAttachmentRef }[],
    route: { provider: string; model: string },
    config: VisionConfig,
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
      maxTokens: config.maxTokens,
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
    for (const [index, image] of images.entries()) {
      const reference = visionImageReference(image, index)
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

}

export default VisionService
