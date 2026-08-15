import { describe, expect, it } from 'vitest'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { cacheHitPercent, composerStats, formatTokens } from '../../src/presentation/stats.ts'

describe('composerStats', () => {
  it('matches the Harness Web token, timing, cache, and context formulas', () => {
    const projections: Partial<SessionProjectionMap> = {
      sessionStats: {
        turns: 2,
        steps: 3,
        llmMs: 3_800,
        toolMs: 1_200,
        ttftMs: 1_600,
        ttftSteps: 2,
        decodeMs: 2_500,
        decodeTokens: 50,
      },
      tokenUsage: {
        uncachedInputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      },
      contextPressure: {
        projectedTokens: 45_000,
        pressureTokens: 40_000,
        contextWindow: 100_000,
      },
    }

    expect(composerStats(projections)).toBe(
      '2 turns · 3 steps | LLM 3.8s · Tool call 1.2s | TTFT avg 0.8s · 20 tok/s | Cache hit 90% | Input 1K tok · Output 50 tok | Context 45% · ~45K / 100K',
    )
  })

  it('uses the same compact token and zero-input cache behavior as Web', () => {
    expect(formatTokens(12_200)).toBe('12.2K')
    expect(cacheHitPercent({
      uncachedInputTokens: 0,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })).toBeNull()
  })
})
