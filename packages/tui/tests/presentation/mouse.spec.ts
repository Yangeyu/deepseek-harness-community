import { describe, expect, it } from 'vitest'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  parseMouseReport,
  resolveMouseAction,
} from '../../src/presentation/mouse.ts'

describe('parseMouseReport', () => {
  it('subscribes to passive pointer motion for title hover feedback', () => {
    expect(ENABLE_MOUSE_TRACKING).toContain('?1003h')
    expect(ENABLE_MOUSE_TRACKING).not.toContain('?1002h')
    expect(DISABLE_MOUSE_TRACKING).toContain('?1003l')
  })

  it('decodes motion, click, release, and wheel reports', () => {
    expect(parseMouseReport('\u001b[<35;20;5M')).toEqual({ button: 35, x: 19, y: 4, release: false })
    expect(parseMouseReport('\u001b[<0;1;1M')).toEqual({ button: 0, x: 0, y: 0, release: false })
    expect(parseMouseReport('\u001b[<0;1;1m')).toEqual({ button: 0, x: 0, y: 0, release: true })
    expect(parseMouseReport('\u001b[<65;8;9M')).toEqual({ button: 65, x: 7, y: 8, release: false })
  })

  it('leaves keyboard input untouched', () => {
    expect(parseMouseReport('\u001b[A')).toBeUndefined()
    expect(parseMouseReport('t')).toBeUndefined()
  })
})

describe('resolveMouseAction', () => {
  it('separates primary selection gestures from hover and release', () => {
    expect(resolveMouseAction({ button: 35, x: 4, y: 2, release: false }))
      .toEqual({ kind: 'move', x: 4, y: 2 })
    expect(resolveMouseAction({ button: 0, x: 4, y: 2, release: false }))
      .toEqual({ kind: 'press', x: 4, y: 2 })
    expect(resolveMouseAction({ button: 32, x: 7, y: 2, release: false }))
      .toEqual({ kind: 'drag', x: 7, y: 2 })
    expect(resolveMouseAction({ button: 0, x: 7, y: 2, release: true }))
      .toEqual({ kind: 'release', x: 7, y: 2 })
  })

  it('resolves wheel direction and ignores unsupported buttons', () => {
    expect(resolveMouseAction({ button: 64, x: 0, y: 0, release: false }))
      .toEqual({ kind: 'wheel', direction: -1, x: 0, y: 0 })
    expect(resolveMouseAction({ button: 65, x: 0, y: 0, release: false }))
      .toEqual({ kind: 'wheel', direction: 1, x: 0, y: 0 })
    expect(resolveMouseAction({ button: 2, x: 0, y: 0, release: false }))
      .toEqual({ kind: 'ignored', x: 0, y: 0 })
  })
})
