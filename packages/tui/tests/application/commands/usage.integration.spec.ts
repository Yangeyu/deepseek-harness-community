import { afterEach, expect, it, vi } from 'vitest'
import { createUsageCommand } from '../../../src/application/commands/builtins/usage.ts'
import { ProviderUsageProcess } from '../../../src/modules/usage/process.ts'
import type { ProviderUsage } from '../../../src/modules/usage/contracts.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'

afterEach(() => { vi.useRealTimers() })

it('shares /usage results with the footer and discards superseded or retired reads', async () => {
  vi.useFakeTimers()
  const background = Promise.withResolvers<ProviderUsage>()
  const explicit = Promise.withResolvers<ProviderUsage>()
  const late = Promise.withResolvers<ProviderUsage>()
  const read = vi.fn().mockReturnValueOnce(background.promise).mockReturnValueOnce(explicit.promise).mockReturnValueOnce(late.promise)
  const scope = new LifecycleScope('usage-test')
  const usage = new ProviderUsageProcess({ read }, scope, vi.fn())
  usage.observe('openai-codex')
  const command = createUsageCommand({
    current: { modelCatalog: {
      default: { provider: 'openai-codex', model: 'gpt-test' },
      routableProviders: ['openai-codex'], groups: [], failures: [],
    }, projections: {} },
    captureSession: () => ({ active: true }),
    notice: vi.fn(),
  }, usage, scope.signal).handler('')
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
