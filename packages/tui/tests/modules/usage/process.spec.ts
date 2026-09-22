import { afterEach, expect, it, vi } from 'vitest'
import { ProviderUsageProcess } from '../../../src/modules/usage/process.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'

afterEach(() => { vi.useRealTimers() })

it('hides unavailable quota, reports manual failures, and stops retrying on disposal', async () => {
  vi.useFakeTimers()
  const read = vi.fn()
    .mockResolvedValueOnce({ provider: 'openai-codex', checkedAt: 0, groups: [
      { label: 'Codex', windows: [{ durationSeconds: 18000, usedPercent: 20 }] },
    ] })
    .mockRejectedValue(new Error('Usage request failed'))
  const scope = new LifecycleScope('usage-test')
  const usage = new ProviderUsageProcess({ read }, scope, vi.fn())
  usage.observe('openai-codex')
  await vi.advanceTimersByTimeAsync(0)
  expect(usage.summary).toBe('5h 80% left')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(usage.summary).toBe('')
  await expect(usage.read('openai-codex', scope.signal)).rejects.toThrow('Usage request failed')
  await scope.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
