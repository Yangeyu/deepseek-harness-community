import type {
  ImageAttachmentRef,
  ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { MessageId, TokenUsage } from '@deepseek-ai/dsh-llm'

export interface VisionObservationBlock {
  readonly type: 'community-vision-observation'
  readonly text: string
}

export type VisionMode = 'auto' | 'proxy' | 'disabled'

export interface VisionConfig {
  mode: VisionMode
  proxyProvider: string
  proxyModel: string
  maxObservationChars: number
  maxTokens: number
}

export interface VisionImageInput {
  /** Stable label already embedded exactly once in the owning user request. */
  readonly reference: string
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name?: string
}

export type VisionUnavailableReason =
  | 'disabled'
  | 'proxy-unavailable'
  | 'proxy-does-not-support-images'

export type ResolvedImageRoute =
  | { readonly strategy: 'native'; readonly provider: string; readonly model: string }
  | {
      readonly strategy: 'proxy'
      readonly provider: string
      readonly model: string
      readonly maxObservationChars: number
      readonly maxTokens: number
    }
  | {
      readonly strategy: 'disabled'
      readonly reason: VisionUnavailableReason
      readonly message: string
    }

export type ResolvedProxyImageRoute = Extract<ResolvedImageRoute, { strategy: 'proxy' }>

export interface VisionRequest {
  readonly analysisId: string
  readonly sessionId: string
  readonly userText: string
  readonly images: readonly VisionImageInput[]
}

/** Provider facts shared by direct inspection, admission carriers, and durable evidence. */
export interface VisionResultMetadata {
  readonly provider: string
  readonly model: string
  readonly attachments: readonly ImageAttachmentRef[]
  readonly durationMs: number
  readonly truncated: boolean
  readonly finishReason: string
  readonly usage?: TokenUsage
}

export interface VisionInspection extends VisionResultMetadata {
  readonly observation: string
}

/** Durable evidence adds an identity to the common provider result. */
export interface VisionEvidenceMetadata extends VisionResultMetadata {
  readonly analysisId: string
}

export interface VisionAnalysis extends VisionEvidenceMetadata {
  readonly sessionId: string
  readonly observation: string
}

export interface VisionAdmissionRequest {
  readonly analysis: VisionAnalysis
  readonly promptText: string
  readonly mode: 'queue' | 'steer'
  readonly rpcId: string
  readonly clientTimeZone?: string
}

/** Structured provenance persisted inside the supported `user/message` event. */
export interface VisionEvidenceSource extends VisionEvidenceMetadata {
  readonly kind: 'community-vision'
  /** Stable identity of the admitted human Prompt that owns this evidence. */
  readonly promptId: MessageId
}

/** Complete pre-admission carrier that keeps proxy media model-invisible. */
export interface VisionSubmissionSource extends VisionEvidenceMetadata {
  readonly kind: 'community-vision-submission'
  readonly sessionId: string
  readonly rpcId: string
  readonly clientTimeZone?: string
}

export interface VisionStatus {
  config: VisionConfig
  proxyRegistered: boolean
  proxySupportsImages: boolean
}
