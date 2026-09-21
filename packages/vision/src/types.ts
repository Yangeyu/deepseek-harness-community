import type {
  ImageAttachmentRef,
  ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

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
  readonly userText: string
  readonly images: readonly VisionImageInput[]
}

/** Provider facts shared by proxy analysis and direct inspection. */
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

/** Analysis data; the caller owns evidence formatting, persistence, and submission. */
export interface VisionAnalysis extends VisionResultMetadata {
  readonly analysisId: string
  /** Sanitized raw observation body, limited to maxObservationChars. */
  readonly observation: string
  /** Exact image labels, in the same order as attachments. */
  readonly references: readonly string[]
}

export interface VisionStatus {
  config: VisionConfig
  proxyRegistered: boolean
  proxySupportsImages: boolean
}
