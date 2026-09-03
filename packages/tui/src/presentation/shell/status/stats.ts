/** Read-only formatting for Host-owned session projections. */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Compact token count using the same thresholds as the Harness Web composer. */
export function formatTokens(value: number): string {
  const scaled = (number: number): string => number >= 100
    ? String(Math.round(number))
    : String(Math.round(number * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

/** Compact duration using the same rounding as the Harness Web composer. */
export function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Decode throughput using the same precision as Harness Web. */
export function formatTokensPerSecond(value: number): string {
  const clamped = Math.max(0, value)
  return clamped >= 10
    ? String(Math.round(clamped))
    : String(Math.round(clamped * 10) / 10)
}

/** Sum the disjoint prompt-side billing buckets. */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Cache-read share of all billed input, rounded like Harness Web. */
export function cacheHitPercent(usage: TokenUsageProjection): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100)
}

function statsGroups(stats: SessionStatsProjection | undefined): string[] {
  if (stats === undefined || stats.steps === 0) return []
  const groups = [`${stats.turns} turns · ${stats.steps} steps`]
  const durations: string[] = []
  if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`)
  if (stats.toolMs > 0) durations.push(`Tool call ${formatDuration(stats.toolMs)}`)
  if (durations.length > 0) groups.push(durations.join(' · '))
  const speeds: string[] = []
  if (stats.ttftSteps > 0) speeds.push(`TTFT avg ${formatDuration(stats.ttftMs / stats.ttftSteps)}`)
  if (stats.decodeMs > 0) {
    speeds.push(`${formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000))} tok/s`)
  }
  if (speeds.length > 0) groups.push(speeds.join(' · '))
  return groups
}

function usageGroups(usage: TokenUsageProjection | undefined): string[] {
  if (usage === undefined) return []
  const input = billedInputTokens(usage)
  if (input === 0 && usage.outputTokens === 0) return []
  const groups: string[] = []
  const hit = cacheHitPercent(usage)
  if (hit !== null) groups.push(`Cache hit ${hit}%`)
  groups.push(`Input ${formatTokens(input)} tok · Output ${formatTokens(usage.outputTokens)} tok`)
  return groups
}

function contextGroup(pressure: ContextPressureProjection | undefined): string | undefined {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const capacity = pressure?.contextWindow
  if (used === undefined || capacity === undefined) return undefined
  const percent = Math.min(100, Math.round(used / capacity * 100))
  return `Context ${percent}% · ~${formatTokens(used)} / ${formatTokens(capacity)}`
}

/** Web-equivalent whole-session statistics adapted to one terminal line. */
export function composerStats(projections: Partial<SessionProjectionMap>): string {
  const groups = [
    ...statsGroups(projections.sessionStats),
    ...usageGroups(projections.tokenUsage),
  ]
  const context = contextGroup(projections.contextPressure)
  if (context !== undefined) groups.push(context)
  return groups.join(' | ')
}
