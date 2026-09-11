export interface SearchField {
  readonly key: string
  readonly text: string
}

export interface SearchMatch<F extends SearchField> {
  readonly field: F
  /** Offsets into the original field text, in UTF-16 code units. */
  readonly start: number
  readonly end: number
}

export interface RequestSearchIndex<F extends SearchField> {
  readonly totalMatches: number
  readonly query: string
  /** Resolves one zero-based ordinal, in field order then text order. */
  match(ordinal: number, signal: AbortSignal): Promise<SearchMatch<F> | undefined>
}

type SearchProgress = { scannedFields: number; totalMatches: number }
type CountedField<F extends SearchField> = { field: F; count: number }

const CHUNK_SIZE = 16 * 1024
const MAX_QUERY_LENGTH = 4096

async function yieldToInput(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>(resolve => setImmediate(resolve))
  signal.throwIfAborted()
}

// Neither the owned region nor its lookahead may cut a surrogate pair. Otherwise
// a lone-surrogate query could match half of a character at a slice boundary.
function characterBoundary(text: string, offset: number): number {
  if (offset >= text.length) return text.length
  const previous = text.charCodeAt(offset - 1)
  const current = text.charCodeAt(offset)
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
    ? offset + 1
    : offset
}

/** The sole matching path, shared by indexing and cancellable selection rescans. */
async function scanField(
  text: string,
  expression: RegExp,
  queryLength: number,
  signal: AbortSignal,
  onChunk: (count: number, complete: boolean) => void,
  onMatch?: (start: number, end: number) => boolean,
): Promise<number> {
  let count = 0
  let chunkStart = 0
  let nextStart = 0
  do {
    signal.throwIfAborted()
    const chunkEnd = characterBoundary(text, chunkStart + CHUNK_SIZE)
    // Unicode ignore-case is single-code-point folding, not lowercased text.
    // Two code units per query unit bounds even supplementary counterparts.
    const windowEnd = characterBoundary(text, chunkEnd + 2 * queryLength)
    const window = text.slice(chunkStart, windowEnd)
    expression.lastIndex = nextStart - chunkStart
    let match: RegExpExecArray | null
    while ((match = expression.exec(window)) !== null) {
      const start = chunkStart + match.index
      if (start >= chunkEnd) break
      const end = chunkStart + expression.lastIndex
      count += 1
      nextStart = end
      if (onMatch && !onMatch(start, end)) {
        signal.throwIfAborted()
        return count
      }
    }
    chunkStart = chunkEnd
    nextStart = Math.max(nextStart, chunkEnd)
    signal.throwIfAborted()
    onChunk(count, chunkEnd === text.length)
    // Check again after callbacks: a consumer can cancel from progress itself.
    await yieldToInput(signal)
  } while (chunkStart < text.length)
  return count
}

export async function searchRequest<F extends SearchField>(
  fields: Iterable<F>,
  query: string,
  options: {
    caseSensitive?: boolean
    signal: AbortSignal
    onProgress?: (progress: SearchProgress) => void
  },
): Promise<RequestSearchIndex<F>> {
  const { signal, onProgress } = options
  signal.throwIfAborted()
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Search query exceeds the ${MAX_QUERY_LENGTH} UTF-16 code unit limit.`)
  }
  const source = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags = options.caseSensitive ? 'gu' : 'giu'
  const countedFields: CountedField<F>[] = []
  let scannedFields = 0
  let totalMatches = 0
  onProgress?.({ scannedFields, totalMatches })
  signal.throwIfAborted()
  if (query.length > 0) {
    const expression = new RegExp(source, flags)
    for (const field of fields) {
      const previousTotal = totalMatches
      const count = await scanField(field.text, expression, query.length, signal, (count, complete) => {
        totalMatches = previousTotal + count
        if (complete) scannedFields += 1
        onProgress?.({ scannedFields, totalMatches })
      })
      // Retain canonical field objects only for fields with hits, never copies
      // of field text or a position array proportional to the number of hits.
      if (count > 0) countedFields.push({ field, count })
    }
  }
  signal.throwIfAborted()
  return {
    query,
    totalMatches,
    async match(ordinal, selectionSignal) {
      selectionSignal.throwIfAborted()
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
        throw new RangeError('Search match ordinal must be a non-negative safe integer.')
      }
      if (ordinal >= totalMatches) return undefined
      let skip = ordinal
      let visitedFields = 0
      for (const { field, count } of countedFields) {
        selectionSignal.throwIfAborted()
        if (++visitedFields % 64 === 0) await yieldToInput(selectionSignal)
        if (skip >= count) {
          skip -= count
          continue
        }
        let selected: SearchMatch<F> | undefined
        await scanField(field.text, new RegExp(source, flags), query.length, selectionSignal, () => {}, (start, end) => {
          if (skip > 0) {
            skip -= 1
            return true
          }
          selected = { field, start, end }
          return false
        })
        selectionSignal.throwIfAborted()
        return selected
      }
      return undefined
    },
  }
}
