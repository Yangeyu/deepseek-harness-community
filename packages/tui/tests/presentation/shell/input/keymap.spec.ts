import { describe, expect, it } from 'vitest'
import {
  resolveKeymapInput,
  type KeymapContext,
} from '../../../../src/presentation/shell/input/keymap.ts'
import { resolveTerminalInput } from '../../../../src/presentation/shell/input/resolve-terminal-input.ts'
import { decodeTerminalInput } from '../../../../src/infrastructure/terminal/decode-input.ts'

const idle: KeymapContext = {
  working: false,
  imageSubmissionBusy: false,
  hasAttachments: false,
  composerEmpty: true,
  autocompleteVisible: false,
  interactionActive: false,
  surfaceActive: false,
  attachmentRailFocused: false,
}
const working = { ...idle, working: true }

function keymap(raw: string, context = idle) {
  return resolveKeymapInput(decodeTerminalInput(raw), context)
}

function input(raw: string, context = idle) {
  return resolveTerminalInput(decodeTerminalInput(raw), context)
}

describe('keymap', () => {
  it('queues with Tab only while working and leaves Alt+Enter to the editor', () => {
    expect(keymap('\t')).toEqual({ kind: 'unmatched' })
    expect(keymap('\t', working)).toEqual({
      kind: 'action',
      action: 'turn.queue',
    })
    expect(keymap('\u001b\r', working)).toEqual({ kind: 'unmatched' })
  })

  it('resolves contextual navigation and Escape from the same binding table', () => {
    expect(keymap('\u001b[5~')).toEqual({ kind: 'action', action: 'history.page-up' })
    expect(keymap('\u001b[A', { ...idle, composerEmpty: false })).toEqual({
      kind: 'action',
      action: 'draft.previous',
    })
    expect(keymap('\u001b', working)).toEqual({ kind: 'action', action: 'run.interrupt' })
    expect(keymap('\u001b', { ...idle, autocompleteVisible: true })).toEqual({ kind: 'unmatched' })
    expect(keymap('\u001b', { ...idle, interactionActive: true })).toEqual({
      kind: 'action',
      action: 'interaction.cancel',
    })
  })

  it('uses Ctrl+V only and suppresses its Kitty repeat and release events', () => {
    expect(keymap('\u001b[118;5u')).toEqual({
      kind: 'action',
      action: 'vision.paste',
    })
    expect(keymap('\u001b[118;5:2u')).toEqual({ kind: 'suppressed' })
    expect(keymap('\u001b[118;5:3u')).toEqual({ kind: 'suppressed' })
  })

  it('normalizes pointer, selection, rewind, and Escape routing before behavior', () => {
    expect(input('\u001b[<64;8;9M')).toMatchObject({
      clearSelection: false,
      disarmRewind: false,
      route: { kind: 'pointer', action: { kind: 'wheel' } },
    })
    expect(input('x')).toEqual({
      clearSelection: true,
      disarmRewind: true,
      route: { kind: 'passthrough' },
    })
    expect(input('\u001b[27;1:3u').route).toEqual({ kind: 'suppressed' })
  })

  it('maps focused Surface gestures before feature behavior runs', () => {
    const menu = { ...idle, surfaceActive: true, surfaceInput: 'menu' as const }
    expect(keymap('j', menu)).toEqual({ kind: 'action', action: 'surface.next' })
    expect(keymap('\r', menu)).toEqual({ kind: 'action', action: 'surface.confirm' })
    expect(keymap('\u001b', menu)).toEqual({ kind: 'action', action: 'surface.back' })

    const approval = { ...menu, interactionActive: true, surfaceInput: 'approval' as const }
    expect(keymap('\u001b', approval)).toEqual({ kind: 'action', action: 'interaction.cancel' })
    expect(keymap('2', approval)).toEqual({ kind: 'action', action: 'surface.select-2' })
  })

  it('has no equal-priority conflict in any reachable Surface context', () => {
    const contexts = [
      'approval', 'choice', 'memory', 'menu', 'model-menu', 'multi-select',
      'rewind-confirm', 'rewind-point', 'skills', 'text-input', 'trajectory', 'web-menu',
    ] as const
    const inputs = [
      '\u001b', '\u0003', '\t', '\u001b[Z', '\u001b[A', '\u001b[B',
      '\u001b[C', '\u001b[D', '\u001b[5~', '\u001b[6~', '\r', ' ',
      'g', 'G', 'h', 'j', 'J', 'k', 'K', 'l', 'r', 'R', '1', '9',
    ]
    for (const surfaceInput of contexts) {
      for (const raw of inputs) {
        expect(() => keymap(raw, {
          ...idle,
          surfaceActive: true,
          surfaceInput,
          interactionActive: surfaceInput === 'approval' || surfaceInput === 'multi-select',
        })).not.toThrow()
      }
    }
  })
})
