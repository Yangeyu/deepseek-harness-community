import type {
  ModelCatalog,
  ModelCatalogFailure,
  ModelProviderGroup,
  ModelSelection,
} from '../../runtime/session/contracts.ts'
import type { VisionConfig, VisionMode, VisionStatus } from '@vascent/deepseek-harness-vision'
import type { CommunityWebStatus, WebSearchSelection } from '@vascent/deepseek-harness-web'

/** Configuration-facing aggregate derived from the catalog and Session projection. */
export interface ModelDirectorySnapshot {
  readonly current: ModelSelection
  readonly routable: boolean
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly ModelCatalogFailure[]
}

/** Consumer-owned model operations used by Configuration and startup policy. */
export interface ModelPort {
  refresh(): Promise<ModelCatalog>
  select(selection: ModelSelection): Promise<void>
}

export interface VisionConfigurationPort {
  readonly config: VisionConfig
  status(signal?: AbortSignal): Promise<VisionStatus>
  setMode(mode: VisionMode): Promise<void>
}

export interface WebConfigurationPort {
  status(signal?: AbortSignal): Promise<CommunityWebStatus>
  setSearchProvider(provider: WebSearchSelection): Promise<void>
}

export interface ConfigurationCommandPort {
  dispatch(command: string): Promise<boolean>
  dispatchHost(command: string): Promise<void>
}

/** Durable permission preset applied by the Host to future Sessions. */
export interface PermissionDefaultPort {
  setDefaultPreset(preset: string): Promise<void>
}
