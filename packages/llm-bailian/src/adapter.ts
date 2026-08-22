import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  BAILIAN_DISPLAY_NAME,
  BAILIAN_PROVIDER_ID,
  type ResolvedBailianConfig,
  type ResolvedBailianModel,
} from './config.ts'
import { modelInfo, resolvedModelInfo } from './model.ts'
import { serializeRequest } from './request.ts'
import { streamBailianResponse } from './transport.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

export interface BailianAdapterOptions {
  options: () => ResolvedBailianConfig
  resolveApiKey: (config: ResolvedBailianConfig) => Promise<string>
  resolveAttachments?: () => AttachmentStore | undefined
}

export class BailianAdapter extends LlmAdapter {
  constructor(private readonly config: BailianAdapterOptions) {
    super()
  }

  private assertProvider(provider: string): void {
    if (provider !== BAILIAN_PROVIDER_ID) {
      throw new LlmError(`Bailian adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
  }

  private model(config: ResolvedBailianConfig, provider: string, model: string): ResolvedBailianModel {
    this.assertProvider(provider)
    const resolved = config.models.get(model)
    if (resolved === undefined) {
      throw new LlmError(`Bailian provider has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    this.assertProvider(provider)
    return { id: provider, name: BAILIAN_DISPLAY_NAME }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    this.assertProvider(provider)
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider)
    return Promise.resolve([...this.config.options().models.values()].map(model => modelInfo(provider, model)))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    _signal?.throwIfAborted()
    const config = this.config.options()
    return resolvedModelInfo(provider, this.model(config, provider, model))
  }

  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const config = this.config.options()
    return Promise.resolve({
      model: resolvedModelInfo(provider, this.model(config, provider, model)),
      stream: options => this.streamWithConfig(options, config),
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConfig(options, this.config.options())
  }

  private async * streamWithConfig(
    options: GenerateOptions,
    config: ResolvedBailianConfig,
  ): AsyncIterable<StreamChunk> {
    const model = this.model(config, options.provider, options.model)
    const apiKey = await this.config.resolveApiKey(config)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, config.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, model, config, apiKey, watchdog.signal, () => {
      watchdog.pulse()
    })[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`Bailian stream idle timeout after ${String(config.streamIdleTimeoutMs)}ms`, 'TIMEOUT', {
          cause: error,
        })
      }
      if (options.signal?.aborted) {
        throw new LlmError('Bailian request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Bailian API stream from ${config.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Bailian stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {}
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    model: ResolvedBailianModel,
    config: ResolvedBailianConfig,
    apiKey: string,
    signal: AbortSignal,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const body = await serializeRequest(options, model, this.config.resolveAttachments?.(), signal)
    yield* streamBailianResponse({ config, apiKey, body, signal, onComment })
  }
}
