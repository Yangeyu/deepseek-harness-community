import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { ProviderAuthenticationPort } from '../../modules/authentication/contracts.ts'

/** Subscription connections exposed by this bundle. */
const connections: Readonly<Record<string, { key: string; method: string }>> = {
  'openai-codex': { key: 'llm-pi-ai/openai-codex', method: 'oauth' },
}

/** Adapt declared connections through the Host authorization catalog. */
export function harnessProviderAuthentication(
  authorization: Pick<AuthorizationService, 'list' | 'begin'>,
): ProviderAuthenticationPort {
  const flow = (provider: string) => {
    const connection = connections[provider]
    if (connection === undefined) return undefined
    const entry = authorization.list().find(entry => entry.key === connection.key)
    return entry?.methods.some(method => method.id === connection.method) ? { key: entry.key, label: entry.label, method: connection.method } : undefined
  }
  return {
    async list() {
      return Object.keys(connections).flatMap(provider => {
        const entry = flow(provider)
        return entry === undefined ? [] : [{ provider, label: entry.label }]
      })
    },
    async authorize(provider, interaction, signal) {
      const entry = flow(provider)
      if (entry === undefined) throw new Error(`No authorization flow for ${provider}`)
      const outcome = await authorization.begin({ key: entry.key, method: entry.method, interaction, signal })
      return outcome.status === 'authorized'
    },
  }
}
