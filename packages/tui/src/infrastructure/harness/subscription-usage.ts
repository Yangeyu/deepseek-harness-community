import { parseCredentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { ProviderUsage, ProviderUsagePort, UsageWindow } from '../../modules/usage/contracts.ts'
import { codexConnection } from './authentication.ts'

const usageUrl = 'https://chatgpt.com/backend-api/wham/usage'
const requestTimeoutMs = 20_000

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid subscription usage response.')
  return value as Record<string, unknown>
}

function credential(record: CredentialRecord | undefined): OAuthCredential & { accountId: string } {
  const value = record?.kind === 'grant' ? record.payload as Partial<OAuthCredential> | null : undefined
  if (value?.type !== 'oauth' || typeof value.access !== 'string' || typeof value.refresh !== 'string'
    || typeof value.expires !== 'number' || typeof value.accountId !== 'string') {
    throw new Error('Sign in with /connect openai-codex to check subscription usage.')
  }
  return value as OAuthCredential & { accountId: string }
}

function windows(value: unknown): UsageWindow[] {
  if (value == null) return []
  const limit = object(value)
  return [limit.primary_window, limit.secondary_window].flatMap(value => {
    if (value == null) return []
    const window = object(value)
    const { limit_window_seconds: durationSeconds, used_percent: usedPercent, reset_at: resetsAt } = window
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0
      || typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0
      || (resetsAt != null && (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)))) {
      throw new Error('Invalid subscription quota window.')
    }
    return [{ durationSeconds, usedPercent, ...resetsAt == null ? {} : { resetsAt } }]
  })
}

/** Companion quota adapter: Host owns records and locking; pi-ai owns token exchange. */
export function harnessSubscriptionUsage(
  credentials: Pick<CredentialProvider, 'modifyRecord'>,
  request: typeof fetch = fetch,
): ProviderUsagePort {
  return {
    async read(provider, callerSignal) {
      if (provider !== codexConnection.provider) return undefined
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(requestTimeoutMs)])
      signal.throwIfAborted()
      const record = await credentials.modifyRecord(parseCredentialKey(codexConnection.key), async current => {
        signal.throwIfAborted()
        const stored = credential(current)
        if (stored.expires > Date.now() + requestTimeoutMs) return undefined
        const { openaiCodexProvider } = await import('@earendil-works/pi-ai/providers/openai-codex')
        try {
          const refreshed = await openaiCodexProvider().auth.oauth!.refresh(stored, signal)
          return { kind: 'grant', payload: refreshed }
        } catch {
          signal.throwIfAborted()
          throw new Error('Subscription login could not be refreshed. Sign in with /connect openai-codex.')
        }
      })
      signal.throwIfAborted()
      const account = credential(record)
      const response = await request(usageUrl, {
        headers: { Authorization: `Bearer ${account.access}`, 'ChatGPT-Account-Id': account.accountId, Accept: 'application/json' },
        signal, redirect: 'error',
      })
      if (response.status === 401) throw new Error('Subscription login was rejected. Sign in with /connect openai-codex.')
      if (!response.ok) throw new Error(`Subscription usage query failed (HTTP ${String(response.status)}).`)
      const data = object(await response.json().catch(() => { throw new Error('Invalid subscription usage response.') }))
      const groups: ProviderUsage['groups'][number][] = []
      const add = (label: string, limit: unknown) => {
        const reported = windows(limit)
        if (reported.length > 0) groups.push({ label, windows: reported })
      }
      add('Codex', data.rate_limit)
      if (data.additional_rate_limits != null) {
        if (!Array.isArray(data.additional_rate_limits)) throw new Error('Invalid subscription usage groups.')
        for (const value of data.additional_rate_limits) {
          const group = object(value)
          const label = group.limit_name ?? group.metered_feature
          if (typeof label !== 'string') throw new Error('Invalid subscription usage group name.')
          add(label, group.rate_limit)
        }
      }
      add('Code review', data.code_review_rate_limit)
      return { provider, checkedAt: Date.now(), groups, ...typeof data.plan_type === 'string' ? { plan: data.plan_type } : {} }
    },
  }
}
