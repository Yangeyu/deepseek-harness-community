import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { BailianAdapter } from './adapter.ts'
import {
  assertBailianConfig,
  BAILIAN_DISPLAY_NAME,
  BAILIAN_PROVIDER_ID,
  Config,
  resolveBailianConfig,
  type ResolvedBailianConfig,
} from './config.ts'
import { createBailianProfile, type ResolvedBailianProviderProfile } from './provider.ts'

export { BailianAdapter, type BailianAdapterOptions } from './adapter.ts'
export {
  assertBailianConfig,
  BAILIAN_DISPLAY_NAME,
  BAILIAN_PROVIDER_ID,
  Config,
  DEFAULT_BAILIAN_API_KEY_ENV,
  DEFAULT_BAILIAN_BASE_URL,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveBailianBaseURL,
  resolveBailianConfig,
  type BailianModelConfig,
  type BailianReasoningConfig,
  type Config as BailianConfig,
  type ResolvedBailianConfig,
  type ResolvedBailianModel,
  type ResolvedBailianReasoningPolicy,
} from './config.ts'
export {
  BAILIAN_REASONING_EFFORT_IDS,
  BAILIAN_SELECTABLE_EFFORT_IDS,
  bailianCompat,
  createBailianPiModel,
  type BailianPiModelInput,
} from './model.ts'
export {
  createBailianProfile,
  createBailianProvider,
  transformBailianPayload,
  type ResolvedBailianProviderProfile,
} from './provider.ts'

export const name = 'llm-bailian'
export const inject = ['llm']
export const BAILIAN_SETTINGS_NAMESPACE = settingsNamespace('llm-bailian')

function registrationFacts(profile: ResolvedBailianProviderProfile): object {
  return {
    provider: profile.provider,
    displayName: profile.displayName,
    retryPolicy: profile.retryPolicy,
  }
}

/** Register the single `bailian` provider route with live settings and credentials. */
export function apply(ctx: Context, config: Config): void {
  let current = () => config
  let lastRaw: Config | undefined
  let lastResolved: ResolvedBailianConfig | undefined
  let lastProfiles: ReadonlyMap<string, ResolvedBailianProviderProfile> | undefined
  const profiles = (): ReadonlyMap<string, ResolvedBailianProviderProfile> => {
    const raw = current()
    if (raw === lastRaw && lastProfiles !== undefined) return lastProfiles
    const resolved = resolveBailianConfig(raw)
    lastRaw = raw
    lastResolved = resolved
    lastProfiles = new Map([[BAILIAN_PROVIDER_ID, createBailianProfile(resolved)]])
    return lastProfiles
  }
  profiles()

  const resolveApiKey = async (): Promise<string> => {
    const ref = lastResolved?.apiKeyEnv ?? credentialRef('DASHSCOPE_API_KEY')
    const credentials = ctx.get('credentials')
    const value = credentials === undefined
      ? launchEnvironmentOf(ctx).get(ref)?.value
      : (await credentials.resolve(ref))?.value
    if (value !== undefined && value.length > 0) return assertUsableApiKey(value, name, ref)
    throw new LlmError(
      `${name}: no API key for provider route "${BAILIAN_PROVIDER_ID}"; store or export ${ref}`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new BailianAdapter({
    profiles,
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
  let registeredFacts = registrationFacts(profiles().get(BAILIAN_PROVIDER_ID)!)
  const refreshRegistration = () => {
    const profile = profiles().get(BAILIAN_PROVIDER_ID)!
    const next = registrationFacts(profile)
    if (deepEqualJson(next, registeredFacts)) return
    registration.replace([BAILIAN_PROVIDER_ID])
    registeredFacts = next
  }
  installSettingsSection(ctx, BAILIAN_SETTINGS_NAMESPACE, Config, config, {
    validate: assertBailianConfig,
    setSource: source => { current = source },
    onChange: refreshRegistration,
  })
}
