import { describe, expect, it } from 'vitest'
import { resolveKeymapInput } from '../../src/input/keymap.ts'

const idle = { working: false, hasAttachments: false }
const working = { working: true, hasAttachments: false }

describe('keymap', () => {
  it('queues with Tab only while working and leaves Alt+Enter to the editor', () => {
    expect(resolveKeymapInput('\t', idle)).toEqual({ kind: 'unmatched' })
    expect(resolveKeymapInput('\t', working)).toEqual({
      kind: 'action',
      action: 'turn.queue',
    })
    expect(resolveKeymapInput('\u001b\r', working)).toEqual({ kind: 'unmatched' })
  })

  it('uses Ctrl+V only and suppresses its Kitty repeat and release events', () => {
    expect(resolveKeymapInput('\u001b[118;5u', idle)).toEqual({
      kind: 'action',
      action: 'vision.paste',
    })
    expect(resolveKeymapInput('\u001b[118;5:2u', idle)).toEqual({ kind: 'suppressed' })
    expect(resolveKeymapInput('\u001b[118;5:3u', idle)).toEqual({ kind: 'suppressed' })
  })
})
