import { describe, expect, it } from 'vitest'
import { parseMouseReport } from '../../src/presentation/mouse.ts'

describe('parseMouseReport', () => {
  it('decodes hover, click, release, and wheel reports', () => {
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
