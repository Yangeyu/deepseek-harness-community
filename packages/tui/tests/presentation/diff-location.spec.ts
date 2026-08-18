import { describe, expect, it, vi } from 'vitest'
import type { TuiState } from '../../src/runtime/controller.ts'
import { DiffLineLocator, locateHunkStart } from '../../src/presentation/diff-location.ts'

describe('locateHunkStart', () => {
  it('returns the absolute line for one unique applied hunk', () => {
    expect(locateHunkStart('one\ntwo\nchanged\nfour\n', 'two\nchanged\nfour')).toBe(2)
  })

  it('rejects missing and ambiguous after-images', () => {
    expect(locateHunkStart('same\nsame\n', 'same')).toBeUndefined()
    expect(locateHunkStart('one\ntwo\n', 'missing')).toBeUndefined()
    expect(locateHunkStart('one\ntwo\n', '')).toBeUndefined()
  })

  it('publishes one immutable snapshot and skips an unchanged event window', async () => {
    const locator = new DiffLineLocator()
    const initial = locator.current
    const onChange = vi.fn()
    const events = [{
      event: {
        type: 'tool/result',
        seq: 1,
        data: { message: { source: { kind: 'tool', callId: 'call-write' } } },
      },
      view: {
        for: 'result',
        view: {
          card: 'diff',
          diffs: [{ path: 'src/new.ts', oldText: null, newText: 'export {}\n' }],
        },
      },
    }]
    const snapshot = {
      sessionId: 'session-diff',
      cwd: '/workspace',
      events,
    } as unknown as TuiState

    locator.resolve(snapshot, onChange)
    await vi.waitFor(() => { expect(onChange).toHaveBeenCalledTimes(1) })
    expect(locator.current).not.toBe(initial)
    expect(locator.current.get('call-write:diff')).toEqual([1])

    const resolved = locator.current
    locator.resolve(snapshot, onChange)
    await Promise.resolve()
    expect(locator.current).toBe(resolved)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
