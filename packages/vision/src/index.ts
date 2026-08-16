import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  BlockAssembler,
  createUserMessage,
  type ContentBlock,
  type LlmFailure,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_PROVIDER,
  VisionConfigSchema,
} from './config.ts'
import {
  VISION_SYSTEM_PROMPT,
  visionUserPrompt,
  wrapObservation,
} from './observation.ts'
import { chooseVisionRoute } from './routing.ts'
import { VisionObservationStage } from './events.ts'
import type {
  VisionAdmissionRequest,
  VisionAnalysis,
  VisionCapability,
  VisionConfig,
  VisionEvidenceSource,
  VisionImageInput,
  VisionObservationBlock,
  VisionRequest,
  VisionStatus,
  VisionSubmissionSource,
} from './types.ts'

export { VisionConfigSchema as Config }
export { chooseVisionRoute } from './routing.ts'
export { VISION_SYSTEM_PROMPT, visionUserPrompt, wrapObservation } from './observation.ts'
export type {
  VisionAdmissionRequest,
  VisionAnalysis,
  VisionCapability,
  VisionConfig,
  VisionEvidenceSource,
  VisionImageInput,
  VisionMode,
  VisionObservationBlock,
  VisionRequest,
  VisionStatus,
  VisionUnavailableReason,
} from './types.ts'

const PLUGIN_NAME = 'community-vision'
const VISION_NAMESPACE = settingsNamespace('vision')
const PI_AI_NAMESPACE = settingsNamespace('llm-pi-ai')

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

function registeredProfile(value: unknown, provider: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const providers = (value as Record<string, unknown>).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return undefined
  const profile = (providers as Record<string, unknown>)[provider]
  return typeof profile === 'object' && profile !== null && !Array.isArray(profile)
    ? profile as Record<string, unknown>
    : undefined
}

/** Host-owned Vision policy, proxy analysis, and staged evidence service. */
export class VisionService extends Service {
  static inject = ['agents', 'attachments', 'credentials', 'llm', 'settings']
  static Config = VisionConfigSchema

  private readonly settings: SettingsScope<VisionConfig>
  private readonly observations: VisionObservationStage

  constructor(ctx: Context, config: VisionConfig) {
    super(ctx, 'vision')
    this.settings = ctx.settings.register(VISION_NAMESPACE, VisionConfigSchema, { base: config, applies: 'live' })
    this.observations = new VisionObservationStage(ctx)
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
    const config = this.config
    const proxy = await this.ctx.llm.resolveModelInfo(config.proxyProvider, config.proxyModel, signal)
      .catch(() => undefined)
    const profile = registeredProfile(this.ctx.settings.get(PI_AI_NAMESPACE), config.proxyProvider)
    const rawRef = profile?.apiKeyEnv
    const ref = typeof rawRef === 'string' && rawRef.trim() !== '' ? rawRef : undefined
    const rawEndpoint = profile?.baseURL
    let endpointHost: string | undefined
    if (typeof rawEndpoint === 'string') {
      try {
        endpointHost = new URL(rawEndpoint).host
      } catch {}
    }
    const credential = ref === undefined ? undefined : await this.ctx.credentials.describe(credentialRef(ref))
    signal?.throwIfAborted()
    return {
      config,
      proxyRegistered: proxy !== undefined,
      proxySupportsImages: proxy?.inputModalities?.includes('image') ?? false,
      ...endpointHost === undefined ? {} : { proxyEndpointHost: endpointHost },
      ...ref === undefined ? {} : { credentialRef: ref },
      ...credential === undefined ? {} : {
        credentialConfigured: credential.configured,
        ...credential.source === undefined ? {} : { credentialSource: credential.source },
      },
    }
  }

  async setMode(mode: VisionConfig['mode']): Promise<void> {
    await this.settings.update({ mode })
  }

  async configureRecommendedDashScope(): Promise<void> {
    const previous = this.ctx.settings.describe().find(descriptor => descriptor.ns === PI_AI_NAMESPACE)?.user
    await this.ctx.settings.mutate(PI_AI_NAMESPACE, [{
      op: 'set',
      path: ['providers', DEFAULT_VISION_PROVIDER],
      value: {
        displayName: 'Alibaba Cloud Bailian',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultInput: ['text', 'image'],
        models: [{
          id: DEFAULT_VISION_MODEL,
          name: 'Qwen3.7 Plus',
          contextWindow: 991_808,
          maxTokens: 65_536,
        }],
      },
    }])
    try {
      await this.settings.update({
        mode: 'auto',
        proxyProvider: DEFAULT_VISION_PROVIDER,
        proxyModel: DEFAULT_VISION_MODEL,
      })
    } catch (error: unknown) {
      await this.ctx.settings.replace(PI_AI_NAMESPACE, typeof previous === 'object' && previous !== null ? previous : {})
      throw error
    }
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
    if (request.images.length === 0) throw new VisionError('NO_IMAGES', 'Vision analysis requires at least one image.')
    if (this.ctx.agents.get(SessionId(request.sessionId)) === undefined) {
      throw new VisionError('SESSION_UNAVAILABLE', 'The active session is no longer available.')
    }
    const config = this.config
    if (config.mode === 'disabled') throw new VisionError('VISION_DISABLED', 'Vision is disabled. Open /config vision to enable it.')
    const status = await this.status(signal)
    if (!status.proxyRegistered) {
      throw new VisionError('PROXY_UNAVAILABLE', `Vision proxy ${config.proxyProvider}/${config.proxyModel} is unavailable.`)
    }
    if (!status.proxySupportsImages) {
      throw new VisionError('PROXY_NOT_MULTIMODAL', `Vision proxy ${config.proxyProvider}/${config.proxyModel} does not declare image input support.`)
    }
    if (status.credentialRef !== undefined && status.credentialConfigured !== true) {
      throw new VisionError('CREDENTIAL_MISSING', `Vision credential ${status.credentialRef} is not configured.`)
    }
    const startedAt = Date.now()
    const saved: ImageAttachmentRef[] = []
    await this.validateBatch(request.images)
    signal?.throwIfAborted()
    for (const image of request.images) {
      const ref = await this.ctx.attachments.saveImage(image)
      saved.push(ref)
      signal?.throwIfAborted()
    }
    const info = await this.ctx.llm.resolveModelInfo(config.proxyProvider, config.proxyModel, signal)
    if (!info.inputModalities?.includes('image')) {
      throw new VisionError('PROXY_NOT_MULTIMODAL', `Vision proxy ${info.provider}/${info.id} does not declare image input support.`)
    }
    const assembler = new BlockAssembler()
    const content: ContentBlock[] = [
      { type: 'text', text: visionUserPrompt(request.userText, saved.length) },
      ...saved.map(attachment => ({ type: 'image' as const, attachment })),
    ]
    for await (const chunk of this.ctx.llm.stream({
      provider: info.provider,
      model: info.id,
      system: VISION_SYSTEM_PROMPT,
      messages: [createUserMessage({ content, source: { kind: 'plugin', plugin: PLUGIN_NAME } })],
      maxTokens: config.maxTokens,
      ...signal === undefined ? {} : { signal },
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw this.failureError(finish.failure)
    const raw = textOf(assembler.blocks())
    if (raw === '') throw new VisionError('EMPTY_OBSERVATION', 'The Vision model returned no readable observation.')
    const wrapped = wrapObservation(raw, info.provider, info.id, config.maxObservationChars)
    const truncated = wrapped.truncated || finish.kind === 'max-tokens'
    const durationMs = Date.now() - startedAt
    const source: VisionEvidenceSource = {
      kind: 'community-vision',
      analysisId: request.analysisId,
      provider: info.provider,
      model: info.id,
      attachments: saved,
      durationMs,
      finishReason: finish.kind,
      truncated,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
    this.observations.set(request.analysisId, {
      sessionId: request.sessionId,
      observation: wrapped.text,
      source,
    })
    return {
      analysisId: request.analysisId,
      provider: info.provider,
      model: info.id,
      observation: wrapped.text,
      attachments: saved,
      durationMs,
      truncated,
      finishReason: finish.kind,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
  }

  private async validateBatch(images: readonly VisionImageInput[]): Promise<void> {
    const limits = this.ctx.attachments.imageLimits
    if (images.length > limits.maxImagesPerMessage) {
      throw new VisionError('TOO_MANY_IMAGES', `A message may contain at most ${String(limits.maxImagesPerMessage)} images.`)
    }
    const bytes = images.reduce((total, image) => total + image.data.byteLength, 0)
    if (bytes > limits.maxMessageImageBytes) {
      throw new VisionError('IMAGES_TOO_LARGE', `Attached images exceed the ${String(limits.maxMessageImageBytes)} byte message limit.`)
    }
    await Promise.all(images.map(image => this.ctx.attachments.validateImage(image)))
  }

  private failureError(failure: LlmFailure): VisionError {
    return new VisionError(failure.code, safeErrorMessage(failure.message))
  }

}

export default VisionService
