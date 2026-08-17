import type {
  ImageAttachmentRef,
  ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { MessageId, TokenUsage } from '@deepseek-ai/dsh-llm'

export interface VisionObservationBlock {
  type: 'community-vision-observation'
  text: string
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
  data: Uint8Array
  mediaType: ImageMediaType
  name?: string
}

export type VisionUnavailableReason =
  | 'disabled'
  | 'main-model-unavailable'
  | 'proxy-unavailable'
  | 'proxy-does-not-support-images'

export type VisionCapability =
  | { strategy: 'native'; provider: string; model: string }
  | { strategy: 'proxy'; provider: string; model: string }
  | { strategy: 'disabled'; reason: VisionUnavailableReason; message: string }

export interface VisionRequest {
  analysisId: string
  sessionId: string
  userText: string
  images: readonly VisionImageInput[]
}

/** Provider facts shared by analysis, admission carriers, and durable evidence. */
export interface VisionEvidenceMetadata {
  analysisId: string
  provider: string
  model: string
  attachments: readonly ImageAttachmentRef[]
  durationMs: number
  truncated: boolean
  finishReason: string
  usage?: TokenUsage
}

export interface VisionAnalysis extends VisionEvidenceMetadata {
  observation: string
}

export interface VisionAdmissionRequest {
  analysisId: string
  sessionId: string
  promptText: string
  mode: 'queue' | 'steer'
  rpcId: string
  clientTimeZone?: string
}

/** Structured provenance persisted inside the supported `user/message` event. */
export interface VisionEvidenceSource extends VisionEvidenceMetadata {
  kind: 'community-vision'
  /** Stable identity of the admitted human Prompt that owns this evidence. */
  promptId: MessageId
}

/** Durable, pre-admission carrier that keeps proxy media recoverable but model-invisible. */
export interface VisionSubmissionSource extends VisionEvidenceMetadata {
  kind: 'community-vision-submission'
  sessionId: string
  rpcId: string
  clientTimeZone?: string
}

export interface VisionStatus {
  config: VisionConfig
  proxyRegistered: boolean
  proxySupportsImages: boolean
  proxyEndpointHost?: string
  credentialRef?: string
  credentialConfigured?: boolean
  credentialSource?: string
}
