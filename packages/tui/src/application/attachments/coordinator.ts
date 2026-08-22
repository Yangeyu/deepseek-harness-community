import type { ModelSelection } from '@deepseek-ai/dsh-host-apiproxy'
import type {
  ResolvedImageRoute,
  ResolvedProxyImageRoute,
  VisionAdmissionRequest,
  VisionAnalysis,
  VisionConfig,
  VisionRequest,
  VisionStatus,
} from '@vascent/deepseek-harness-vision'
import type {
  PreparedPrompt,
  PromptPreparationContext,
} from '../../runtime/controller.ts'
import { compilePromptDocument } from '../../prompt-content.ts'
import { AttachmentDraftStore } from './drafts.ts'

export interface VisionGateway {
  readonly config: VisionConfig
  newAnalysisId(): string
  resolveImageRoute(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedImageRoute>
  status(signal?: AbortSignal): Promise<VisionStatus>
  setMode(mode: VisionConfig['mode']): Promise<void>
  analyze(
    route: ResolvedProxyImageRoute,
    request: VisionRequest,
    signal?: AbortSignal,
  ): Promise<VisionAnalysis>
  admit(request: VisionAdmissionRequest): void | Promise<void>
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
    send: PreparedPromptSender,
  ): Promise<'native' | 'proxy'> {
    if (this.active !== undefined) throw new Error('Vision analysis is already in progress.')
    const prompt = compilePromptDocument(text, this.drafts.snapshot)
    const images = prompt.images
    if (images.length === 0) throw new Error('No images are attached.')
    const abort = new AbortController()
    const active = { abort, restoreDrafts: true }
    this.active = active
    let route: 'native' | 'proxy' | undefined
    try {
      await send(prompt.text, mode, async (preparation) => {
        this.drafts.clear()
        const resolved = await this.vision.resolveImageRoute(selection.provider, selection.model, abort.signal)
        if (resolved.strategy === 'disabled') throw new Error(resolved.message)
        if (resolved.strategy === 'native') {
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
        const analysis = await this.vision.analyze(resolved, {
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
        abort.signal.throwIfAborted()
        return {
          kind: 'admission',
          commit: async ({ rpcId, clientTimeZone }) => {
            abort.signal.throwIfAborted()
            await this.vision.admit({
              analysis,
              promptText: prompt.text,
              mode,
              rpcId: String(rpcId),
              ...clientTimeZone === undefined ? {} : { clientTimeZone },
            })
            active.restoreDrafts = false
          },
        }
      })
      if (route === undefined) throw new Error('Vision did not resolve an image route.')
      return route
    } catch (error: unknown) {
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

}
