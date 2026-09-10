import { describe, expect, it } from 'vitest'
import { formatUsage } from '../../../src/modules/usage/format.ts'

describe('subscription usage display', () => {
  it('labels each server-defined window with remaining quota and reset time', () => {
    const resetsAt = 1_789_437_804
    const text = formatUsage({ provider: 'openai-codex', plan: 'pro', checkedAt: 0, groups: [
      { label: 'Codex', windows: [{ durationSeconds: 604800, usedPercent: 45, resetsAt }] },
      { label: 'Spark', windows: [{ durationSeconds: 18000, usedPercent: 0 }] },
      { label: 'Other', windows: [{ durationSeconds: 86400, usedPercent: 105 }] },
    ] })
    expect(text).toContain('Codex\n  Weekly: 55% left')
    expect(text).toContain(new Date(resetsAt * 1000).toLocaleString(undefined, { timeZoneName: 'short' }))
    expect(text).toContain('Spark\n  5h: 100% left · reset time unavailable')
    expect(text).toContain('Other\n  1d: 0% left')
  })

  it('reports missing windows without inferring a quota', () => {
    expect(formatUsage({ provider: 'openai-codex', checkedAt: 0, groups: [] })).toContain('No quota windows reported.')
  })
})
