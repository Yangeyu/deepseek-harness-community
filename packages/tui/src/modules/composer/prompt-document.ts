import {
  imageMarkerNumber,
  imageMarkerOccurrences,
  type InlineImageToken,
} from './image-reference.ts'

export type InlinePromptPart<Image extends InlineImageToken> =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: Image }

export interface CompiledPromptDocument<Image extends InlineImageToken> {
  readonly text: string
  readonly parts: readonly InlinePromptPart<Image>[]
  readonly images: readonly Image[]
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
