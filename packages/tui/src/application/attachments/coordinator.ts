import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { ModelSelection } from '@deepseek-ai/dsh-host-apiproxy'
import type {
  VisionAdmissionRequest,
  VisionAnalysis,
  VisionCapability,
  VisionConfig,
  VisionReferencedImageInput,
  VisionRequest,
  VisionStatus,
} from '@vascent/deepseek-harness-vision'
import type {
  PreparedPrompt,
  PromptPreparationContext,
} from '../../runtime/controller.ts'
import { compilePromptDocument } from '../../prompt-content.ts'
import { AttachmentDraftStore } from './drafts.ts'

export type ComposerVisionRequest = Omit<VisionRequest, 'images'> & {
  readonly images: readonly VisionReferencedImageInput[]
}

export interface VisionGateway {
  readonly config: VisionConfig
  newAnalysisId(): string
  supportsNativeImages(provider: string, model: string, signal?: AbortSignal): Promise<boolean>
  capability(provider: string, model: string, signal?: AbortSignal): Promise<VisionCapability>
  status(signal?: AbortSignal): Promise<VisionStatus>
  setMode(mode: VisionConfig['mode']): Promise<void>
  analyze(request: ComposerVisionRequest, signal?: AbortSignal): Promise<VisionAnalysis>
  admit(request: VisionAdmissionRequest): void | Promise<void>
  discard(analysisId: string): void
}

export type PreparedPromptSender = (
  displayText: string,
  mode: 'queue' | 'steer',
  prepareContent: (context: PromptPreparationContext) => Promise<PreparedPrompt>,
) => Promise<void>

interface ActiveImageSubmission {
  abort: AbortController
  restoreDrafts: boolean
}

/** Owns the only image submission state machine between the composer and Harness. */
export class AttachmentCoordinator {
  private active: ActiveImageSubmission | undefined

  constructor(
    readonly drafts: AttachmentDraftStore,
    private readonly vision: VisionGateway,
  ) {}

  get busy(): boolean {
    return this.active !== undefined
  }

  cancel(restoreDrafts = true): void {
    const active = this.active
    if (active === undefined) return
    active.restoreDrafts = restoreDrafts
    active.abort.abort(new Error('Vision analysis cancelled.'))
  }

  async submit(
    sessionId: string,
    selection: ModelSelection,
    text: string,
    mode: 'queue' | 'steer',
    limits: ImageAttachmentLimits | undefined,
    send: PreparedPromptSender,
  ): Promise<'native' | 'proxy'> {
    if (this.active !== undefined) throw new Error('Vision analysis is already in progress.')
    const prompt = compilePromptDocument(text, this.drafts.snapshot)
    const images = prompt.images
    if (images.length === 0) throw new Error('No images are attached.')
    const ids = images.map(image => image.id)
    try {
      this.checkLimits(images, limits)
    } catch (error: unknown) {
      this.drafts.setError(ids, error instanceof Error ? error.message : String(error))
      throw error
    }
    const abort = new AbortController()
    const active = { abort, restoreDrafts: true }
    this.active = active
    let route: 'native' | 'proxy' | undefined
    let stagedAnalysisId: string | undefined
    try {
      await send(prompt.text, mode, async (preparation) => {
        this.drafts.clear()
        const capability = await this.vision.capability(selection.provider, selection.model, abort.signal)
        if (capability.strategy === 'disabled') throw new Error(capability.message)
        if (capability.strategy === 'native') {
          route = 'native'
          return {
            kind: 'content',
            content: prompt.parts.map(part => part.type === 'text'
              ? { type: 'text' as const, text: part.text }
              : {
                  type: 'image' as const,
                  mediaType: part.image.mediaType,
                  data: Buffer.from(part.image.data).toString('base64'),
                  name: part.image.name,
                }),
          }
        }
        route = 'proxy'
        const analysisId = this.vision.newAnalysisId()
        preparation.setActivity({ kind: 'vision', analysisId, imageCount: images.length })
        const status = await this.vision.status(abort.signal)
        if (!status.proxyRegistered || !status.proxySupportsImages) {
          throw new Error(`Vision proxy ${status.config.proxyProvider}/${status.config.proxyModel} is not ready. Open /config vision.`)
        }
        const analysis = await this.vision.analyze({
          analysisId,
          sessionId,
          userText: prompt.text,
          images: images.map(image => ({
            reference: image.placeholder,
            data: image.data,
            mediaType: image.mediaType,
            name: image.name,
          })),
        }, abort.signal)
        stagedAnalysisId = analysisId
        abort.signal.throwIfAborted()
        return {
          kind: 'admission',
          commit: async ({ rpcId, clientTimeZone }) => {
            abort.signal.throwIfAborted()
            await this.vision.admit({
              analysisId: analysis.analysisId,
              sessionId,
              promptText: prompt.text,
              mode,
              rpcId: String(rpcId),
              ...clientTimeZone === undefined ? {} : { clientTimeZone },
            })
            stagedAnalysisId = undefined
            active.restoreDrafts = false
          },
        }
      })
      if (route === undefined) throw new Error('Vision did not resolve an image route.')
      return route
    } catch (error: unknown) {
      if (stagedAnalysisId !== undefined) this.vision.discard(stagedAnalysisId)
      const message = error instanceof Error ? error.message : String(error)
      if (active.restoreDrafts) {
        if (abort.signal.aborted) this.drafts.restore(images)
        else this.drafts.restore(images, message)
      }
      throw error
    } finally {
      if (this.active === active) this.active = undefined
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
