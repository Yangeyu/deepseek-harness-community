export type DurationDensity = 'inline' | 'detail' | 'compact' | 'elapsed'

/** Format one duration consistently across terminal presentation densities. */
export function formatDuration(
  milliseconds: number,
  density: DurationDensity = 'inline',
): string {
  const duration = Math.max(0, milliseconds)
  if (density === 'elapsed' && duration < 60_000) {
    return `${String(Math.floor(duration / 1_000))}s`
  }
  if (duration < 1_000) {
    const value = String(Math.round(duration))
    return density === 'detail' ? `${value} ms` : `${value}ms`
  }
  if (duration < 60_000) {
    const decimals = density === 'detail'
      ? duration < 10_000 ? 2 : 1
      : duration < 10_000 ? 1 : 0
    const value = (duration / 1_000).toFixed(decimals)
    return density === 'detail' ? `${value} s` : `${value}s`
  }
  const minutes = Math.floor(duration / 60_000)
  const seconds = Math.floor(duration % 60_000 / 1_000)
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`
}
