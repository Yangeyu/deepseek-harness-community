import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedBailianProviderProfile } from './provider.ts'

export interface BailianAdapterOptions extends Omit<PiAiAdapterOptions, 'profiles'> {
  /** Current immutable Bailian profiles; read once for each adapter operation. */
  profiles: () => ReadonlyMap<string, ResolvedBailianProviderProfile>
}

interface AdapterSnapshot {
  readonly profiles: ReadonlyMap<string, ResolvedBailianProviderProfile>
  readonly delegate: PiAiAdapter
}

/** Bailian-owned adapter surface backed by the shared pi-ai transport vocabulary. */
export class BailianAdapter extends LlmAdapter {
  private snapshot?: AdapterSnapshot

  constructor(private readonly options: BailianAdapterOptions) {
    super()
  }

  /** Keep per-model reasoning defaults and the provider collection on one settings snapshot. */
  private current(): AdapterSnapshot {
    const profiles = this.options.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    this.snapshot = {
      profiles,
      delegate: new PiAiAdapter({
        ...this.options,
        profiles: () => profiles,
      }),
    }
    return this.snapshot
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.current().delegate.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().delegate.providerRetryPolicy(provider)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.current().delegate.listModels(provider)
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const snapshot = this.current()
    const resolved = await snapshot.delegate.resolveModel(provider, model, signal)
    const defaultEffort = snapshot.profiles.get(provider)?.defaultReasoningEfforts.get(model)
    if (defaultEffort === undefined || resolved.reasoning === undefined) return resolved
    return {
      ...resolved,
      reasoning: {
        ...resolved.reasoning,
        defaultEffort,
      },
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const snapshot = this.current()
    const defaultEffort = snapshot.profiles
      .get(options.provider)
      ?.defaultReasoningEfforts.get(options.model)
    return snapshot.delegate.stream(
      options.reasoningEffort === undefined && defaultEffort !== undefined
        ? { ...options, reasoningEffort: defaultEffort }
        : options,
    )
  }
}
