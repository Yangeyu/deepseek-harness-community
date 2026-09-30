import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
  WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE,
  type Config as DeepSeekSearchConfig,
} from '@deepseek-ai/dsh-web-search-deepseek'

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

interface ResolvedDeepSeekSearchRoute {
  apiKey?: string
  apiKeyRef: string
  baseURL: string
  model: string
  apiVersion: string
  maxTokens: number
  maxUses: number
}

export interface DeepSeekSearchRouteStatus {
  apiKeyRef: string
  baseURL: string
  literalCredentialConfigured: boolean
}

function settingsConfig(ctx: Context): Partial<{ [K in keyof DeepSeekSearchConfig]: ReturnType<DeepSeekSearchConfig[K]['get']> }> {
  const value = ctx.settings.describe().find(entry => entry.ns === WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE)?.value
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Partial<{ [K in keyof DeepSeekSearchConfig]: ReturnType<DeepSeekSearchConfig[K]['get']> }>
    : {}
}

function resolveRoute(ctx: Context): ResolvedDeepSeekSearchRoute {
  const config = settingsConfig(ctx)
  const apiKey = typeof config.apiKey === 'string' && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...apiKey === undefined ? {} : { apiKey },
    apiKeyRef: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
    apiVersion: config.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: config.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
  }
}

/** Follow the upstream account route and let the account service enforce the endpoint allowlist. */
export async function deepSeekSearchAccountToken(ctx: Context, endpoint: string): Promise<string | undefined> {
  if (ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider !== 'deepseek-account') return undefined
  return ctx.get('deepseekAccount')?.resolveToken(endpoint)
}

/** Reuse the official DeepSeek search transport while keeping selection in the community policy layer. */
export function createDeepSeekSearchProvider(ctx: Context): DeepSeekSearchProvider {
  return new DeepSeekSearchProvider(() => {
    const route = resolveRoute(ctx)
    const apiKeyRef = credentialRef(route.apiKeyRef)
    return {
      ...route.apiKey === undefined ? {} : { apiKey: route.apiKey },
      resolveAccountToken: endpoint => deepSeekSearchAccountToken(ctx, endpoint),
      resolveApiKey: async () => (await ctx.credentials.resolve(apiKeyRef))?.value,
      apiKeyEnv: apiKeyRef,
      baseURL: route.baseURL,
      model: route.model,
      apiVersion: route.apiVersion,
      maxTokens: route.maxTokens,
      maxUses: route.maxUses,
      recordRequest: request => {
        ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', request)
      },
    }
  })
}

/** Secret-free projection of the official provider settings used by configuration surfaces. */
export function deepSeekSearchRouteStatus(ctx: Context): DeepSeekSearchRouteStatus {
  const route = resolveRoute(ctx)
  return {
    apiKeyRef: route.apiKeyRef,
    baseURL: route.baseURL,
    literalCredentialConfigured: route.apiKey !== undefined,
  }
}
