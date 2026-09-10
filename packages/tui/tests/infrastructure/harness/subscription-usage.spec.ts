import { describe, expect, it, vi } from 'vitest'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { harnessSubscriptionUsage } from '../../../src/infrastructure/harness/subscription-usage.ts'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({
  openaiCodexProvider: () => ({ auth: { oauth: { refresh } } }),
}))

function store(expires = Date.now() + 3_600_000) {
  let record: CredentialRecord | undefined = {
    kind: 'grant', payload: { type: 'oauth', access: 'test-access', refresh: 'test-refresh', accountId: 'test-account', expires },
  }
  let tail = Promise.resolve<unknown>(undefined)
  const modifyRecord = vi.fn<CredentialProvider['modifyRecord']>((_key, mutate) => {
    const result = tail.then(async () => {
      const next = await mutate(record)
      if (next !== undefined) record = next
      return record
    })
    tail = result.catch(() => {})
    return result
  })
  return { modifyRecord, get record() { return record }, clear() { record = undefined } }
}

const window = (seconds: number, used: number) => ({ limit_window_seconds: seconds, used_percent: used, reset_at: 1_789_437_804 })
const signal = () => new AbortController().signal

describe('subscription quota adapter', () => {
  it('reads account-wide and separate model quotas without inventing an absent window', async () => {
    const credentials = store()
    const before = credentials.record
    const request = vi.fn<typeof fetch>(async () => Response.json({
      plan_type: 'pro', email: 'private@example.invalid',
      rate_limit: { primary_window: window(604800, 45), secondary_window: null },
      additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { primary_window: window(18000, 0), secondary_window: window(604800, 0) } }],
    }))
    const result = await harnessSubscriptionUsage(credentials, request).read('openai-codex', signal())
    expect(result).toEqual({
      provider: 'openai-codex', plan: 'pro', checkedAt: expect.any(Number),
      groups: [
        { label: 'Codex', windows: [{ durationSeconds: 604800, usedPercent: 45, resetsAt: 1_789_437_804 }] },
        { label: 'Spark', windows: [
          { durationSeconds: 18000, usedPercent: 0, resetsAt: 1_789_437_804 },
          { durationSeconds: 604800, usedPercent: 0, resetsAt: 1_789_437_804 },
        ] },
      ],
    })
    expect(request).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: 'Bearer test-access', 'ChatGPT-Account-Id': 'test-account', Accept: 'application/json' },
      signal: expect.any(AbortSignal), redirect: 'error',
    })
    expect(credentials.record).toBe(before)
  })

  it('serializes refresh through the Host record lock and reuses the rotated credential', async () => {
    const credentials = store(0)
    const rotated = { type: 'oauth', access: 'rotated-access', refresh: 'rotated-refresh', accountId: 'rotated-account', expires: Date.now() + 3_600_000 }
    refresh.mockReset().mockResolvedValue(rotated)
    const request = vi.fn<typeof fetch>(async () => Response.json({ rate_limit: null }))
    const port = harnessSubscriptionUsage(credentials, request)
    await Promise.all([port.read('openai-codex', signal()), port.read('openai-codex', signal())])
    expect(refresh).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ refresh: 'test-refresh' }), expect.any(AbortSignal))
    expect(credentials.record).toEqual({ kind: 'grant', payload: rotated })
    expect(request.mock.calls.every(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer rotated-access')).toBe(true)
  })

  it('reports unsupported providers without accessing another account', async () => {
    const credentials = store()
    const request = vi.fn<typeof fetch>()
    expect(await harnessSubscriptionUsage(credentials, request).read('openai', signal())).toBeUndefined()
    expect(credentials.modifyRecord).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('directs an unsigned account to the explicit connection command', async () => {
    const credentials = store()
    credentials.clear()
    const request = vi.fn<typeof fetch>()
    await expect(harnessSubscriptionUsage(credentials, request).read('openai-codex', signal())).rejects.toThrow('/connect openai-codex')
    expect(request).not.toHaveBeenCalled()
  })

  it.each([401, 403, 429])('reports HTTP %s without exposing the response body', async status => {
    const request = vi.fn<typeof fetch>(async () => new Response('private error details', { status }))
    await expect(harnessSubscriptionUsage(store(), request).read('openai-codex', signal()))
      .rejects.toThrow(status === 401 ? 'Subscription login was rejected.' : `HTTP ${String(status)}`)
  })

  it('rejects malformed quota values instead of displaying a full allowance', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } }))
    await expect(harnessSubscriptionUsage(store(), request).read('openai-codex', signal())).rejects.toThrow('Invalid subscription quota window')
  })
})
