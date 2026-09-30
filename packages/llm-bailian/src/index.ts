import type { Context, Volatile } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { BailianAdapter } from './adapter.ts'
import {
  BAILIAN_DISPLAY_NAME,
  BAILIAN_PROVIDER_ID,
  Config as ConfigSchema,
  type Config as BailianConfig,
  assertBailianConfig,
  resolveBailianConfig,
  type ResolvedBailianConfig,
} from './config.ts'

export { BailianAdapter, type BailianAdapterOptions } from './adapter.ts'
export {
  assertBailianConfig,
  BAILIAN_DISPLAY_NAME,
  BAILIAN_PROVIDER_ID,
  BAILIAN_REASONING_EFFORT_IDS,
  DEFAULT_BAILIAN_API_KEY_ENV,
  DEFAULT_BAILIAN_BASE_URL,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveBailianBaseURL,
  resolveBailianConfig,
  type BailianInputModality,
  type BailianMaxTokensField,
  type BailianModelConfig,
  type BailianReasoningConfig,
  type BailianReasoningEffort,
  type BailianReasoningLevelConfig,
  type Config as BailianConfig,
  type ResolvedBailianConfig,
  type ResolvedBailianModel,
  type ResolvedBailianReasoningLevel,
  type ResolvedBailianReasoningPolicy,
} from './config.ts'
export const Config = ConfigSchema.volatile()
export const name = 'llm-bailian'
export const inject = ['llm']
export const BAILIAN_SETTINGS_NAMESPACE = 'llm-bailian'

export function apply(ctx: Context, config: Volatile<BailianConfig>): void {
  let snapshot = resolveBailianConfig(structuredClone(config.get()) as BailianConfig)

  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this === ctx.fiber) assertBailianConfig(ConfigSchema(raw as BailianConfig))
    return raw
  })

  const resolveApiKey = async (snapshot: ResolvedBailianConfig): Promise<string> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(snapshot.apiKeyEnv)
      if (hit !== undefined) return assertUsableApiKey(hit.value, name, snapshot.apiKeyEnv)
    } else {
      const hit = launchEnvironmentOf(ctx).get(snapshot.apiKeyEnv)
      if (hit !== undefined && hit.value.length > 0) {
        return assertUsableApiKey(hit.value, name, snapshot.apiKeyEnv)
      }
    }
    throw new LlmError(
      `${name}: no API key for provider route "${BAILIAN_PROVIDER_ID}"; store or export ${snapshot.apiKeyEnv}`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new BailianAdapter({
    options: () => snapshot,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerConfigurableProviders([{
    provider: BAILIAN_PROVIDER_ID,
    displayName: BAILIAN_DISPLAY_NAME,
    settingsNs: BAILIAN_SETTINGS_NAMESPACE,
    settingsPath: [],
  }])
  const registration = ctx.llm.registerAdapter([BAILIAN_PROVIDER_ID], adapter)
  ctx.on('loader/volatile-update', () => {
    const next = resolveBailianConfig(structuredClone(config.get()) as BailianConfig)
    const policyChanged = !deepEqualJson(next.retryPolicy, snapshot.retryPolicy)
    snapshot = next
    if (policyChanged) registration.replace([BAILIAN_PROVIDER_ID])
  })
}
