export interface InlineImageToken {
  readonly placeholder: string
}

const IMAGE_MARKER_PATTERN = /\[Image #([1-9]\d*)\]/gu
const IMAGE_MARKER_SINGLE_PATTERN = /^\[Image #([1-9]\d*)\]$/u

export interface ImageMarkerOccurrence {
  readonly marker: string
  readonly index: number
}

function imageMarker(number: number): string {
  return `[Image #${String(number)}]`
}

export function imageMarkerNumber(marker: string): number | undefined {
  const value = IMAGE_MARKER_SINGLE_PATTERN.exec(marker)?.[1]
  return value === undefined ? undefined : Number(value)
}

export function imageMarkerOccurrences(text: string): ImageMarkerOccurrence[] {
  return [...text.matchAll(IMAGE_MARKER_PATTERN)].map(match => ({
    marker: match[0],
    index: match.index,
  }))
}

export function imageMarkers(text: string): string[] {
  return imageMarkerOccurrences(text).map(occurrence => occurrence.marker)
}

export function nextImageMarker(
  text: string,
  occupied: readonly string[],
  startAt = 1,
): { marker: string; next: number } {
  const used = new Set([...imageMarkers(text), ...occupied])
  let number = Math.max(1, startAt)
  while (used.has(imageMarker(number))) number += 1
  return { marker: imageMarker(number), next: number + 1 }
}

/** Add an inline marker at a text cursor without joining adjacent words. */
export function imageMarkerInsertion(
  lines: readonly string[],
  cursor: { readonly line: number; readonly col: number },
  marker: string,
): string {
  const line = lines[cursor.line] ?? ''
  const before = line.slice(0, cursor.col)
  const after = line.slice(cursor.col)
  const leading = before !== '' && !/\s$/u.test(before) ? ' ' : ''
  const trailing = after === '' || !/^\s/u.test(after) ? ' ' : ''
  return `${leading}${marker}${trailing}`
}

function removeFirstImageMarker(text: string, marker: string): string {
  const index = text.indexOf(marker)
  if (index < 0) return text
  const before = text.slice(0, index)
  const after = text.slice(index + marker.length)
  if (/\s$/u.test(before) && /^\s/u.test(after)) return `${before}${after.slice(1)}`
  if (before === '' && after.startsWith(' ')) return after.slice(1)
  if (after === '' && before.endsWith(' ')) return before.slice(0, -1)
  return `${before}${after}`
}

/** Remove every occurrence bound to one attachment without joining surrounding words. */
export function removeImageMarker(text: string, marker: string): string {
  let result = text
  while (result.includes(marker)) result = removeFirstImageMarker(result, marker)
  return result
}
