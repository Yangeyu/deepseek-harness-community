import { describe, expect, it } from 'vitest'
import { locateHunkStart } from '../../src/presentation/diff-location.ts'

describe('locateHunkStart', () => {
  it('returns the absolute line for one unique applied hunk', () => {
    expect(locateHunkStart('one\ntwo\nchanged\nfour\n', 'two\nchanged\nfour')).toBe(2)
  })

  it('rejects missing and ambiguous after-images', () => {
    expect(locateHunkStart('same\nsame\n', 'same')).toBeUndefined()
    expect(locateHunkStart('one\ntwo\n', 'missing')).toBeUndefined()
    expect(locateHunkStart('one\ntwo\n', '')).toBeUndefined()
  })
})
