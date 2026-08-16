import { Context, Service } from "@deepseek-ai/cordis";
import { LlmResolvedModelInfo, TokenUsage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { ImageAttachmentRef, ImageMediaType } from "@deepseek-ai/dsh-attachment";
//#region src/types.d.ts
type VisionMode = 'auto' | 'proxy' | 'disabled';
interface VisionConfig {
  mode: VisionMode;
  proxyProvider: string;
  proxyModel: string;
  maxObservationChars: number;
  maxTokens: number;
}
interface VisionImageInput {
  data: Uint8Array;
  mediaType: ImageMediaType;
  name?: string;
}
type VisionUnavailableReason = 'disabled' | 'main-model-unavailable' | 'proxy-unavailable' | 'proxy-does-not-support-images';
type VisionCapability = {
  strategy: 'native';
  provider: string;
  model: string;
} | {
  strategy: 'proxy';
  provider: string;
  model: string;
} | {
  strategy: 'disabled';
  reason: VisionUnavailableReason;
  message: string;
};
interface VisionRequest {
  analysisId: string;
  sessionId: string;
  userText: string;
  images: readonly VisionImageInput[];
}
interface VisionAnalysis {
  analysisId: string;
  provider: string;
  model: string;
  marker: string;
  observation: string;
  attachments: readonly ImageAttachmentRef[];
  durationMs: number;
  truncated: boolean;
  finishReason: string;
  usage?: TokenUsage;
}
/** Structured provenance persisted inside the supported `user/message` event. */
interface VisionEvidenceSource {
  kind: 'community-vision';
  analysisId: string;
  provider: string;
  model: string;
  attachments: readonly ImageAttachmentRef[];
  durationMs: number;
  finishReason: string;
  truncated: boolean;
  usage?: TokenUsage;
}
interface VisionStatus {
  config: VisionConfig;
  proxyRegistered: boolean;
  proxySupportsImages: boolean;
  proxyEndpointHost?: string;
  credentialRef?: string;
  credentialConfigured?: boolean;
  credentialSource?: string;
}
//#endregion
//#region src/config.d.ts
declare const VisionConfigSchema: z<VisionConfig>;
//#endregion
//#region src/routing.d.ts
declare function chooseVisionRoute(config: VisionConfig, main: LlmResolvedModelInfo | undefined, proxy: LlmResolvedModelInfo | undefined): VisionCapability;
//#endregion
//#region src/observation.d.ts
declare const VISION_SYSTEM_PROMPT: string;
declare function visionUserPrompt(userText: string, imageCount: number): string;
declare function wrapObservation(value: string, provider: string, model: string, maximum: number): {
  text: string;
  truncated: boolean;
};
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    vision: VisionService;
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'community-vision': VisionEvidenceSource;
  }
}
declare class VisionError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions);
}
/** Host-owned Vision policy, proxy analysis, and staged evidence service. */
declare class VisionService extends Service {
  static inject: string[];
  static Config: import("@deepseek-ai/schemastery").default<VisionConfig>;
  private readonly settings;
  private readonly observations;
  constructor(ctx: Context, config: VisionConfig);
  get config(): VisionConfig;
  newAnalysisId(): string;
  supportsNativeImages(provider: string, model: string, signal?: AbortSignal): Promise<boolean>;
  capability(provider: string, model: string, signal?: AbortSignal): Promise<VisionCapability>;
  status(signal?: AbortSignal): Promise<VisionStatus>;
  setMode(mode: VisionConfig['mode']): Promise<void>;
  configureRecommendedDashScope(): Promise<void>;
  discard(analysisId: string): void;
  analyze(request: VisionRequest, signal?: AbortSignal): Promise<VisionAnalysis>;
  private validateBatch;
  private failureError;
}
//#endregion
export { VisionConfigSchema as Config, VISION_SYSTEM_PROMPT, type VisionAnalysis, type VisionCapability, type VisionConfig, VisionError, type VisionEvidenceSource, type VisionImageInput, type VisionMode, type VisionRequest, VisionService, VisionService as default, type VisionStatus, type VisionUnavailableReason, chooseVisionRoute, visionUserPrompt, wrapObservation };
//# sourceMappingURL=index.d.ts.map