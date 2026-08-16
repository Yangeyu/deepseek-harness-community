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

export interface VisionAnalysis {
  analysisId: string
  provider: string
  model: string
  marker: string
  observation: string
  attachments: readonly ImageAttachmentRef[]
  durationMs: number
  truncated: boolean
  finishReason: string
  usage?: TokenUsage
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

export interface VisionAnalysisEvent {
  analysisId: string
  status: 'completed' | 'failed' | 'cancelled'
  route: {
    strategy: 'proxy'
    provider: string
    model: string
  }
  content: Array<{ type: 'image'; attachment: ImageAttachmentRef }>
  durationMs: number
  finishReason?: string
  observation?: string
  truncated?: boolean
  usage?: TokenUsage
  error?: { code: string; message: string }
}
