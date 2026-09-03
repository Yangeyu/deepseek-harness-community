import { describe, expect, it, vi } from 'vitest'
import { attachTerminalInput } from '../../../src/infrastructure/terminal/input-adapter.ts'

describe('attachTerminalInput', () => {
  it('delivers normalized gestures and returns the listener cleanup', () => {
    let rawListener!: (data: string) => { consume?: boolean } | undefined
    const remove = vi.fn()
    const handle = vi.fn(() => ({ consume: true }))
    const screen = {
      addInputListener(listener: typeof rawListener) {
        rawListener = listener
        return remove
      },
    }

    expect(attachTerminalInput(screen, handle)).toBe(remove)
    expect(rawListener('\u001b[A')).toEqual({ consume: true })
    expect(handle).toHaveBeenCalledWith({ kind: 'key', key: 'up', phase: 'press', raw: '\u001b[A' })
  })
})
