import { describe, expect, it } from 'vitest'
import {
  keymapBindingSummaries,
  resolveKeymapInput,
} from '../../src/input/keymap.ts'

const idle = { working: false, hasAttachments: false }
const working = { working: true, hasAttachments: false }

describe('keymap', () => {
  it('uses contextual standard queueing without taking multiline input', () => {
    expect(resolveKeymapInput('\t', idle, 'standard')).toEqual({ kind: 'unmatched' })
    expect(resolveKeymapInput('\t', working, 'standard')).toEqual({
      kind: 'action',
      action: 'turn.queue',
    })
    expect(resolveKeymapInput('\u001b\r', working, 'standard')).toEqual({ kind: 'unmatched' })
  })

  it('keeps the legacy queue binding scoped to active work', () => {
    expect(resolveKeymapInput('\u001b\r', idle, 'legacy')).toEqual({ kind: 'unmatched' })
    expect(resolveKeymapInput('\u001b\r', working, 'legacy')).toEqual({
      kind: 'action',
      action: 'turn.queue',
    })
  })

  it('suppresses Kitty repeat and release events for a matched shortcut', () => {
    expect(resolveKeymapInput('\u001b[118;5u', idle, 'standard')).toEqual({
      kind: 'action',
      action: 'vision.paste',
    })
    expect(resolveKeymapInput('\u001b[118;5:2u', idle, 'standard')).toEqual({ kind: 'suppressed' })
    expect(resolveKeymapInput('\u001b[118;5:3u', idle, 'standard')).toEqual({ kind: 'suppressed' })
  })

  it('exposes stable semantic summaries independently from terminal input', () => {
    expect(keymapBindingSummaries('standard')).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'turn.queue', keys: ['Tab'] }),
      expect.objectContaining({ action: 'vision.paste', keys: ['Ctrl+V', 'Alt+V'] }),
    ]))
  })
})
