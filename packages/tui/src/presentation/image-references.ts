import { imageMarkerOccurrences } from '../prompt-content.ts'

type Paint = (text: string) => string

// One-cell non-whitespace separator keeps a registered reference on one Editor wrap segment.
const EDITOR_REFERENCE_SEPARATOR = '\u2800'
// oxlint-disable-next-line no-control-regex -- Terminal control sequences must remain outside painted text spans.
const TERMINAL_SEQUENCE_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|_[\s\S]*?\u001B\\|\][\s\S]*?(?:\u0007|\u001B\\))/gu

interface TextRange {
  readonly start: number
  readonly end: number
}

interface TerminalToken {
  readonly control: boolean
  readonly value: string
}

function sortedReferences(references: readonly string[]): string[] {
  return [...new Set(references)]
    .filter(reference => reference !== '')
    .sort((left, right) => right.length - left.length)
}

function editorReference(reference: string): string {
  return reference.replaceAll(' ', EDITOR_REFERENCE_SEPARATOR)
}

/** Encode registered references for Editor layout without changing their cell width. */
export function encodeEditorImageReferences(text: string, references: readonly string[]): string {
  let result = text
  for (const reference of sortedReferences(references)) {
    result = result.replaceAll(reference, editorReference(reference))
  }
  return result
}

/** Return the canonical durable representation of Editor-owned references. */
export function decodeEditorImageReferences(text: string, references: readonly string[]): string {
  let result = text
  for (const reference of sortedReferences(references)) {
    result = result.replaceAll(editorReference(reference), reference)
  }
  return result
}

function terminalTokens(text: string): TerminalToken[] {
  const tokens: TerminalToken[] = []
  let offset = 0
  for (const match of text.matchAll(TERMINAL_SEQUENCE_PATTERN)) {
    if (match.index > offset) tokens.push({ control: false, value: text.slice(offset, match.index) })
    tokens.push({ control: true, value: match[0] })
    offset = match.index + match[0].length
  }
  if (offset < text.length) tokens.push({ control: false, value: text.slice(offset) })
  return tokens
}

function knownReferenceRanges(text: string, references: readonly string[]): TextRange[] {
  const candidates: TextRange[] = []
  for (const reference of sortedReferences(references)) {
    for (const form of new Set([reference, editorReference(reference)])) {
      let index = text.indexOf(form)
      while (index >= 0) {
        candidates.push({ start: index, end: index + form.length })
        index = text.indexOf(form, index + form.length)
      }
    }
  }
  candidates.sort((left, right) => left.start - right.start || right.end - left.end)
  const ranges: TextRange[] = []
  for (const candidate of candidates) {
    if (ranges.some(range => candidate.start < range.end && candidate.end > range.start)) continue
    ranges.push(candidate)
  }
  return ranges
}

function paintRanges(text: string, ranges: readonly TextRange[], paintReference: Paint): string {
  const tokens = terminalTokens(text)
  let visibleOffset = 0
  return tokens.map(token => {
    if (token.control) return token.value
    const tokenStart = visibleOffset
    const tokenEnd = tokenStart + token.value.length
    visibleOffset = tokenEnd
    const parts: string[] = []
    let offset = 0
    for (const range of ranges) {
      const start = Math.max(tokenStart, range.start)
      const end = Math.min(tokenEnd, range.end)
      if (start >= end) continue
      const localStart = start - tokenStart
      const localEnd = end - tokenStart
      if (localStart > offset) parts.push(token.value.slice(offset, localStart))
      parts.push(paintReference(token.value.slice(localStart, localEnd)))
      offset = localEnd
    }
    if (offset < token.value.length) parts.push(token.value.slice(offset))
    return parts.join('').replaceAll(EDITOR_REFERENCE_SEPARATOR, ' ')
  }).join('')
}

/** Paint inline image references without changing their durable text or position. */
export function paintImageReferences(
  text: string,
  paintText: Paint,
  paintReference: Paint,
): string {
  const occurrences = imageMarkerOccurrences(text)
  if (occurrences.length === 0) return paintText(text)

  const parts: string[] = []
  let offset = 0
  for (const occurrence of occurrences) {
    const leading = text.slice(offset, occurrence.index)
    if (leading !== '') parts.push(paintText(leading))
    parts.push(paintReference(occurrence.marker))
    offset = occurrence.index + occurrence.marker.length
  }
  const trailing = text.slice(offset)
  if (trailing !== '') parts.push(paintText(trailing))
  return parts.join('')
}

/** Paint only references backed by the current Composer attachment source of truth. */
export function paintKnownImageReferences(
  text: string,
  references: readonly string[],
  paintReference: Paint,
): string {
  const tokens = terminalTokens(text)
  const visibleText = tokens
    .filter(token => !token.control)
    .map(token => token.value)
    .join('')
  return paintRanges(text, knownReferenceRanges(visibleText, references), paintReference)
}
