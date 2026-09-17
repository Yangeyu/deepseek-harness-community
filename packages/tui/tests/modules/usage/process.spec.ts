import { afterEach, expect, it, vi } from 'vitest'
import { ProviderUsageProcess } from '../../../src/modules/usage/process.ts'
import type { ProviderUsage } from '../../../src/modules/usage/contracts.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'

afterEach(() => { vi.useRealTimers() })

it('shares explicit query results with the footer and discards superseded or retired reads', async () => {
  vi.useFakeTimers()
  const background = Promise.withResolvers<ProviderUsage>()
  const explicit = Promise.withResolvers<ProviderUsage>()
  const late = Promise.withResolvers<ProviderUsage>()
  const read = vi.fn().mockReturnValueOnce(background.promise).mockReturnValueOnce(explicit.promise).mockReturnValueOnce(late.promise)
  const scope = new LifecycleScope('usage-test')
  const usage = new ProviderUsageProcess({ read }, scope, vi.fn())
  usage.observe('openai-codex')
  const command = usage.read('openai-codex', scope.signal)
  const latest: ProviderUsage = { provider: 'openai-codex', checkedAt: 2, groups: [
    { label: 'Codex', windows: [{ durationSeconds: 604800, usedPercent: 40 }] },
  ] }
  explicit.resolve(latest)
  await command
  background.resolve({ ...latest, checkedAt: 1, groups: [] })
  await vi.advanceTimersByTimeAsync(0)
  expect(usage.summary).toBe('Weekly 60% left')
  await vi.advanceTimersByTimeAsync(60_000)
  usage.observe(undefined)
  expect(read.mock.calls[2]![1].aborted).toBe(true)
  late.resolve(latest)
  await vi.advanceTimersByTimeAsync(0)
  expect(usage.summary).toBe('')
  expect(vi.getTimerCount()).toBe(0)
  await scope.dispose()
})

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
