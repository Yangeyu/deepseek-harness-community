import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type {
  ModelSelection,
  PromptContentPart,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {
  VisionAnalysis,
  VisionCapability,
  VisionConfig,
  VisionRequest,
  VisionStatus,
} from '@vascent/deepseek-harness-vision'
import { AttachmentDraftStore } from './drafts.ts'

export interface VisionGateway {
  readonly config: VisionConfig
  newAnalysisId(): string
  supportsNativeImages(provider: string, model: string, signal?: AbortSignal): Promise<boolean>
  capability(provider: string, model: string, signal?: AbortSignal): Promise<VisionCapability>
  status(signal?: AbortSignal): Promise<VisionStatus>
  setMode(mode: VisionConfig['mode']): Promise<void>
  configureRecommendedDashScope(): Promise<void>
  analyze(request: VisionRequest, signal?: AbortSignal): Promise<VisionAnalysis>
  discard(analysisId: string): void
}

export type PromptSender = (
  displayText: string,
  mode: 'queue' | 'steer',
  content: PromptContentPart[],
) => Promise<void>

/** Owns the only image submission state machine between the composer and Harness. */
export class AttachmentCoordinator {
  private abort: AbortController | undefined

  constructor(
    readonly drafts: AttachmentDraftStore,
    private readonly vision: VisionGateway,
    private readonly onProxyDisclosure?: (provider: string, model: string) => void,
  ) {}

  cancel(): void {
    this.abort?.abort(new Error('Vision analysis cancelled.'))
  }

  async submit(
    sessionId: string,
    selection: ModelSelection,
    text: string,
    mode: 'queue' | 'steer',
    limits: ImageAttachmentLimits | undefined,
    send: PromptSender,
  ): Promise<'native' | 'proxy'> {
    if (this.abort !== undefined) throw new Error('Vision analysis is already in progress.')
    const images = [...this.drafts.snapshot]
    if (images.length === 0) throw new Error('No images are attached.')
    const ids = images.map(image => image.id)
    try {
      this.checkLimits(images, limits)
    } catch (error: unknown) {
      this.drafts.setStatus(ids, 'error', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.drafts.setStatus(ids, 'analyzing')
    const abort = new AbortController()
    this.abort = abort
    try {
      const capability = await this.vision.capability(selection.provider, selection.model, abort.signal)
      if (capability.strategy === 'disabled') throw new Error(capability.message)
      if (capability.strategy === 'native') {
        const content: PromptContentPart[] = [
          { type: 'text', text },
          ...images.map(image => ({
            type: 'image' as const,
            mediaType: image.mediaType,
            data: Buffer.from(image.data).toString('base64'),
            name: image.name,
          })),
        ]
        await send(text.trim() === '' ? '[Image]' : text, mode, content)
        this.drafts.clear()
        return 'native'
      }
      const status = await this.vision.status(abort.signal)
      if (!status.proxyRegistered || !status.proxySupportsImages) {
        throw new Error(`Vision proxy ${status.config.proxyProvider}/${status.config.proxyModel} is not ready. Open /config vision.`)
      }
      if (status.credentialRef !== undefined && status.credentialConfigured !== true) {
        throw new Error(`Vision credential ${status.credentialRef} is missing. Open /config vision after configuring it.`)
      }
      this.onProxyDisclosure?.(capability.provider, capability.model)
      const analysisId = this.vision.newAnalysisId()
      const analysis = await this.vision.analyze({
        analysisId,
        sessionId,
        userText: text,
        images: images.map(image => ({
          data: image.data,
          mediaType: image.mediaType,
          name: image.name,
        })),
      }, abort.signal)
      try {
        await send(text.trim() === '' ? '[Image]' : text, mode, [
          { type: 'text', text: analysis.marker },
          { type: 'text', text },
        ])
      } catch (error: unknown) {
        this.vision.discard(analysisId)
        throw error
      }
      this.drafts.clear()
      return 'proxy'
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (abort.signal.aborted) this.drafts.setStatus(ids, 'ready')
      else this.drafts.setStatus(ids, 'error', message)
      throw error
    } finally {
      if (this.abort === abort) this.abort = undefined
    }
  }

  private checkLimits(
    images: readonly { data: Uint8Array }[],
    limits: ImageAttachmentLimits | undefined,
  ): void {
    if (limits === undefined) return
    if (images.length > limits.maxImagesPerMessage) {
      throw new Error(`A message may contain at most ${String(limits.maxImagesPerMessage)} images.`)
    }
    const oversized = images.find(image => image.data.byteLength > limits.maxImageBytes)
    if (oversized !== undefined) {
      throw new Error(`Each image must be at most ${String(limits.maxImageBytes)} bytes.`)
    }
    const total = images.reduce((sum, image) => sum + image.data.byteLength, 0)
    if (total > limits.maxMessageImageBytes) {
      throw new Error(`Attached images must total at most ${String(limits.maxMessageImageBytes)} bytes.`)
    }
  }
}
