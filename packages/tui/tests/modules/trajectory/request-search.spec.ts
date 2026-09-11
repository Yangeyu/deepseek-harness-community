import { describe, expect, it } from 'vitest'
import { searchRequest } from '../../../src/modules/trajectory/request-search.ts'

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('request literal search', () => {
  it('searches every supplied field regardless of disclosure and preserves canonical objects', async () => {
    const fields = [
      { key: 'config.model', text: 'Needle-model', collapsed: false },
      { key: 'tools.0.schema', text: 'hidden needle schema', collapsed: true },
      { key: 'messages.0.text', text: 'a NEEDLE in content', collapsed: true },
      { key: 'attachments.0.name', text: 'needle.png', collapsed: true },
    ]
    const index = await searchRequest(new Set(fields), 'needle', { signal: signal() })
    expect(index.query).toBe('needle')
    expect(index.totalMatches).toBe(4)
    for (const [ordinal, field] of fields.entries()) {
      const match = await index.match(ordinal, signal())
      expect(match?.field).toBe(field)
      expect(field.text.slice(match!.start, match!.end).toUpperCase()).toBe('NEEDLE')
    }
  })

  it('reports original UTF-16 offsets with Unicode case folding and exact-case mode', async () => {
    const field = { key: 'unicode', text: 'İ😀K K k ſ S 𐐀𐐨' }
    const insensitive = await searchRequest([field], 'k', { signal: signal() })
    expect(insensitive.totalMatches).toBe(3)
    for (const [ordinal, start] of [3, 5, 7].entries()) {
      expect(await insensitive.match(ordinal, signal())).toEqual({ field, start, end: start + 1 })
    }
    const sensitive = await searchRequest([field], 'k', { signal: signal(), caseSensitive: true })
    expect(sensitive.totalMatches).toBe(1)
    expect(await sensitive.match(0, signal())).toEqual({ field, start: 7, end: 8 })
    const longS = await searchRequest([field], 's', { signal: signal() })
    expect(longS.totalMatches).toBe(2)
    expect(await longS.match(0, signal())).toEqual({ field, start: 9, end: 10 })
    expect(await longS.match(1, signal())).toEqual({ field, start: 11, end: 12 })
    const astral = await searchRequest([field], '𐐨', { signal: signal() })
    expect(astral.totalMatches).toBe(2)
    expect(await astral.match(0, signal())).toEqual({ field, start: 13, end: 15 })
    expect(await astral.match(1, signal())).toEqual({ field, start: 15, end: 17 })
  })

  it('treats all regular expression metacharacters as literal text', async () => {
    const query = '.*+?^${}()|[]\\/'
    const field = { key: 'literal', text: `prefix ${query} suffix ${query}` }
    const index = await searchRequest([field], query, { signal: signal() })
    expect(index.totalMatches).toBe(2)
    for (let ordinal = 0; ordinal < index.totalMatches; ordinal += 1) {
      const match = await index.match(ordinal, signal())
      expect(field.text.slice(match!.start, match!.end)).toBe(query)
    }
  })

  it('finds cross-chunk literals once and retains non-overlapping match order', async () => {
    const prefix = 'x'.repeat(16 * 1024 - 1)
    const field = { key: 'boundary', text: `${prefix}abababa${'x'.repeat(16 * 1024)}ababa` }
    const index = await searchRequest([field], 'aba', { signal: signal() })
    const starts = [prefix.length, prefix.length + 4, prefix.length + 7 + 16 * 1024]
    expect(index.totalMatches).toBe(3)
    for (const [ordinal, start] of starts.entries()) {
      expect(await index.match(ordinal, signal())).toEqual({ field, start, end: start + 3 })
    }
  })

  it('never turns chunk-boundary surrogate halves into standalone characters', async () => {
    const prefix = 'x'.repeat(16 * 1024 - 1)
    const field = { key: 'surrogate', text: `${prefix}😀${prefix}😀\ud83d` }
    const emoji = await searchRequest([field], '😀', { signal: signal() })
    expect(emoji.totalMatches).toBe(2)
    expect(await emoji.match(0, signal())).toEqual({ field, start: prefix.length, end: prefix.length + 2 })
    expect(await emoji.match(1, signal())).toEqual({ field, start: 2 * prefix.length + 2, end: 2 * prefix.length + 4 })
    const lone = await searchRequest([field], '\ud83d', { signal: signal() })
    expect(lone.totalMatches).toBe(1)
    expect(await lone.match(0, signal())).toEqual({ field, start: field.text.length - 1, end: field.text.length })
  })

  it('counts millions of dense hits exactly and selects ordinals across fields', async () => {
    const length = 2_000_003
    const fields = [{ key: 'dense', text: 'a'.repeat(length) }, { key: 'tail', text: 'aa' }]
    const index = await searchRequest(fields, 'a', { signal: signal() })
    expect(index.totalMatches).toBe(length + 2)
    expect(await index.match(length - 1, signal())).toEqual({ field: fields[0], start: length - 1, end: length })
    expect(await index.match(length, signal())).toEqual({ field: fields[1], start: 0, end: 1 })
    expect(await index.match(length + 1, signal())).toEqual({ field: fields[1], start: 1, end: 2 })
    expect(await index.match(index.totalMatches, signal())).toBeUndefined()
  })

  it('reports monotonic partial progress before completing a large field', async () => {
    const progress: { scannedFields: number; totalMatches: number }[] = []
    const fields = [{ key: 'long', text: 'a'.repeat(100_000) }, { key: 'empty', text: '' }]
    const index = await searchRequest(fields, 'a', { signal: signal(), onProgress: value => progress.push(value) })
    expect(progress[0]).toEqual({ scannedFields: 0, totalMatches: 0 })
    expect(progress.some(value => value.scannedFields === 0 && value.totalMatches > 0 && value.totalMatches < 100_000))
      .toBe(true)
    expect(progress.at(-1)).toEqual({ scannedFields: 2, totalMatches: index.totalMatches })
    expect(progress.every((value, position) => position === 0
      || (value.totalMatches >= progress[position - 1]!.totalMatches
        && value.scannedFields >= progress[position - 1]!.scannedFields))).toBe(true)
  })

  it('yields to input while scanning 10 MiB and never publishes progress after cancellation', async () => {
    const controller = new AbortController()
    const progress: { scannedFields: number; totalMatches: number }[] = []
    const reason = new Error('superseded query')
    const pending = searchRequest([{ key: 'large', text: 'x'.repeat(10 * 1024 * 1024) }], 'absent', {
      signal: controller.signal,
      onProgress: value => progress.push(value),
    })
    setImmediate(() => controller.abort(reason))
    await expect(pending).rejects.toBe(reason)
    expect(progress.at(-1)?.scannedFields).toBe(0)
    const published = progress.length
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(progress).toHaveLength(published)
  })

  it('honors cancellation from progress itself without returning an obsolete index', async () => {
    const controller = new AbortController()
    const reason = new Error('closed request')
    let updates = 0
    await expect(searchRequest([{ key: 'text', text: 'a'.repeat(100_000) }], 'a', {
      signal: controller.signal,
      onProgress: value => {
        updates += 1
        if (value.totalMatches > 0) controller.abort(reason)
      },
    })).rejects.toBe(reason)
    expect(updates).toBe(2)
  })

  it('cancels an on-demand deep selection rescan without invalidating the completed index', async () => {
    const field = { key: 'dense', text: 'a'.repeat(1_000_000) }
    const index = await searchRequest([field], 'a', { signal: signal() })
    const controller = new AbortController()
    const pending = index.match(900_000, controller.signal)
    setImmediate(() => controller.abort())
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(await index.match(0, signal())).toEqual({ field, start: 0, end: 1 })
  })

  it('returns no matches for an empty query and rejects oversized queries without truncation', async () => {
    const fields = [{ key: 'text', text: 'a'.repeat(5000) }]
    const empty = await searchRequest(fields, '', { signal: signal() })
    expect(empty.totalMatches).toBe(0)
    expect(await empty.match(0, signal())).toBeUndefined()
    const maximum = await searchRequest(fields, 'a'.repeat(4096), { signal: signal() })
    expect(maximum.totalMatches).toBe(1)
    await expect(searchRequest(fields, 'a'.repeat(4097), { signal: signal() })).rejects.toThrow('4096 UTF-16')
  })

  it('rejects already-cancelled searches and selections even when no matches exist', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(searchRequest([], '', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const index = await searchRequest([], '', { signal: signal() })
    await expect(index.match(0, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
