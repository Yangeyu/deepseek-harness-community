export interface PromptTextBlock {
  readonly type: string
  readonly text?: string
}

export interface InlineImageToken {
  readonly placeholder: string
}

export type InlinePromptPart<Image extends InlineImageToken> =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: Image }

export interface CompiledPromptDocument<Image extends InlineImageToken> {
  readonly text: string
  readonly parts: readonly InlinePromptPart<Image>[]
  readonly images: readonly Image[]
}

const IMAGE_MARKER_PATTERN = /\[Image #([1-9]\d*)\]/gu
const IMAGE_MARKER_SINGLE_PATTERN = /^\[Image #([1-9]\d*)\]$/u

export interface ImageMarkerOccurrence {
  readonly marker: string
  readonly index: number
}

export function imageMarker(number: number): string {
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

function appendMarker(text: string, marker: string): string {
  if (text === '') return marker
  return /\s$/u.test(text) ? `${text}${marker}` : `${text} ${marker}`
}

/**
 * Compatibility-only repair for messages persisted before inline image references.
 * Live composer submission must use compilePromptDocument instead of guessing positions.
 */
export function restoreLegacyImageMarkers(text: string, imageCount: number): string {
  const existing = new Set(imageMarkers(text))
  let result = text
  let number = 1
  while (existing.size < imageCount) {
    const marker = imageMarker(number)
    number += 1
    if (existing.has(marker)) continue
    existing.add(marker)
    result = appendMarker(result, marker)
  }
  return result
}

/** Validate and materialize the one-to-one inline image reference contract. */
export function compilePromptDocument<Image extends InlineImageToken>(
  rawText: string,
  images: readonly Image[],
): CompiledPromptDocument<Image> {
  const text = rawText.trim()
  const byMarker = new Map<string, Image>()
  for (const image of images) {
    if (imageMarkerNumber(image.placeholder) === undefined) {
      throw new Error(`Invalid image reference: ${image.placeholder}`)
    }
    if (byMarker.has(image.placeholder)) {
      throw new Error(`Duplicate attachment reference: ${image.placeholder}`)
    }
    byMarker.set(image.placeholder, image)
  }

  const seen = new Set<string>()
  const occurrences: Array<{ image: Image; index: number }> = []
  for (const occurrence of imageMarkerOccurrences(text)) {
    const marker = occurrence.marker
    const image = byMarker.get(marker)
    if (image === undefined) {
      if (images.length > 0) throw new Error(`Image reference has no attachment: ${marker}`)
      continue
    }
    if (seen.has(marker)) throw new Error(`Image reference appears more than once: ${marker}`)
    seen.add(marker)
    occurrences.push({ image, index: occurrence.index })
  }
  for (const marker of byMarker.keys()) {
    if (!seen.has(marker)) throw new Error(`Attached image is missing its inline reference: ${marker}`)
  }

  const parts: InlinePromptPart<Image>[] = []
  let offset = 0
  for (const occurrence of occurrences) {
    const end = occurrence.index + occurrence.image.placeholder.length
    const leading = text.slice(offset, end)
    if (leading !== '') parts.push({ type: 'text', text: leading })
    parts.push({ type: 'image', image: occurrence.image })
    offset = end
  }
  const trailing = text.slice(offset)
  if (trailing !== '') parts.push({ type: 'text', text: trailing })
  return {
    text,
    parts,
    images: occurrences.map(occurrence => occurrence.image),
  }
}

/** Project exact durable text without inventing image positions. */
export function promptTextFromContent(content: readonly PromptTextBlock[]): string {
  const textBlocks = content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
  const hasImages = content.some(block => block.type === 'image')
  return textBlocks.join(hasImages ? '' : '\n')
}

/** Read-boundary compatibility for old durable messages whose image blocks had no references. */
export function legacyPromptTextFromContent(
  content: readonly PromptTextBlock[],
  imageCount = content.filter(block => block.type === 'image').length,
): string {
  return restoreLegacyImageMarkers(promptTextFromContent(content), imageCount)
}
