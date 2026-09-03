import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'

/** Return the append-only suffix, or undefined when history was replaced or prepended. */
export function appendedHistoryEntries(
  previous: readonly HistoryEntry[],
  next: readonly HistoryEntry[],
): readonly HistoryEntry[] | undefined {
  if (next === previous || (next.length === 0 && previous.length === 0)) return []
  if (next.length < previous.length) return undefined
  if (next.length === previous.length) {
    return next.every((entry, index) => entry === previous[index]) ? [] : undefined
  }
  if (previous.length > 0
    && (next[0] !== previous[0] || next[previous.length - 1] !== previous[previous.length - 1])) return undefined
  return next.slice(previous.length)
}
