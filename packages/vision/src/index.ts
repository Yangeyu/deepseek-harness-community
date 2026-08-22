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
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { VisionConfigSchema } from './config.ts'
import {
  VISION_SYSTEM_PROMPT,
  visionInferenceContent,
  wrapObservation,
  wrapToolObservation,
} from './observation.ts'
import { chooseVisionRoute } from './routing.ts'
import { VisionEvidenceAdmissionAdapter } from './events.ts'
import { createInspectImageTool } from './tool.ts'
import type {
  ResolvedImageRoute,
  ResolvedProxyImageRoute,
  VisionAdmissionRequest,
  VisionAnalysis,
  VisionConfig,
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
export { VISION_SYSTEM_PROMPT, visionUserPrompt, wrapObservation, wrapToolObservation } from './observation.ts'
export type {
  ResolvedImageRoute,
  ResolvedProxyImageRoute,
  VisionAdmissionRequest,
  VisionAnalysis,
  VisionConfig,
  VisionEvidenceMetadata,
  VisionEvidenceSource,
  VisionImageInput,
  VisionInspection,
  VisionMode,
  VisionObservationBlock,
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

/** Proxy fallback policy and evidence adapter built on official media services. */
export class VisionService extends Service {
  static inject = ['agents', 'attachments', 'fs', 'llm', 'settings', 'tools']
  static Config = VisionConfigSchema

  private readonly settings: SettingsScope<VisionConfig>
  private readonly admission: VisionEvidenceAdmissionAdapter

  constructor(ctx: Context, config: VisionConfig) {
    super(ctx, 'vision')
    this.settings = ctx.settings.register(VISION_NAMESPACE, VisionConfigSchema, { base: config, applies: 'live' })
    this.admission = new VisionEvidenceAdmissionAdapter(ctx)
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

  newAnalysisId(): string {
    return randomUUID()
  }

  async resolveImageRoute(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedImageRoute> {
    const config = this.config
    if (config.mode === 'disabled') return chooseVisionRoute(config, undefined, undefined)
    const main = config.mode === 'auto'
      ? await this.ctx.llm.resolveModelInfo(provider, model, signal).catch(() => undefined)
      : undefined
    signal?.throwIfAborted()
    if (config.mode === 'auto' && main?.inputModalities?.includes('image')) {
      return chooseVisionRoute(config, main, undefined)
    }
    const proxy = await this.ctx.llm.resolveModelInfo(config.proxyProvider, config.proxyModel, signal)
      .catch(() => undefined)
    signal?.throwIfAborted()
    return chooseVisionRoute(config, main, proxy)
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

  admit(request: VisionAdmissionRequest): void {
    const agent = this.ctx.agents.get(SessionId(request.analysis.sessionId))
    if (agent === undefined) throw new VisionError('SESSION_UNAVAILABLE', 'The active session is no longer available.')
    const message = this.admission.submission(request)
    if (request.mode === 'steer') agent.steer(message)
    else agent.followup(message)
  }

  async analyze(
    route: ResolvedProxyImageRoute,
    request: VisionRequest,
    signal?: AbortSignal,
  ): Promise<VisionAnalysis> {
    this.assertImages(request.images)
    this.assertReferences(request.images)
    if (this.ctx.agents.get(SessionId(request.sessionId)) === undefined) {
      throw new VisionError('SESSION_UNAVAILABLE', 'The active session is no longer available.')
    }
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
    const wrapped = wrapObservation(
      rawObservation,
      inference.provider,
      inference.model,
      route.maxObservationChars,
      inference.attachments.map((attachment, index) => ({
        attachment,
        reference: request.images[index]!.reference,
      })),
    )
    const truncated = inference.truncated || wrapped.truncated
    return {
      analysisId: request.analysisId,
      sessionId: request.sessionId,
      ...inference,
      observation: wrapped.text,
      truncated,
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
    const request = exec.agent?.session.requestHeader()?.config
    const provider = request?.provider ?? exec.agent?.options.provider
    const model = request?.model ?? exec.agent?.options.model
    if (provider === undefined || model === undefined) {
      throw new VisionError('MODEL_ROUTE_UNAVAILABLE', 'inspect_image could not resolve the current model route.')
    }
    return this.resolveImageRoute(provider, model, exec.signal)
  }

}

export default VisionService
