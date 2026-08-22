import {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type KeyId,
} from '@earendil-works/pi-tui'

/** Semantic actions emitted by the terminal keymap. */
export type KeymapAction =
  | 'app.cancel-or-exit'
  | 'turn.queue'
  | 'vision.paste'
  | 'attachments.focus'
  | 'attachments.remove-last'
  | 'details.toggle'
  | 'reasoning.cycle'

/** Runtime facts used to keep bindings local to the state where they make sense. */
export interface KeymapContext {
  working: boolean
  hasAttachments: boolean
}

export type KeymapResolution =
  | { kind: 'action'; action: KeymapAction }
  | { kind: 'suppressed' }
  | { kind: 'unmatched' }

interface KeymapBinding {
  action: KeymapAction
  key: KeyId
  available(context: KeymapContext): boolean
}

const ALWAYS = (): boolean => true
const WHEN_WORKING = (context: KeymapContext): boolean => context.working
const WITH_ATTACHMENTS = (context: KeymapContext): boolean => context.hasAttachments

const KEYMAP_BINDINGS: readonly KeymapBinding[] = [{
  action: 'app.cancel-or-exit',
  key: Key.ctrl('c'),
  available: ALWAYS,
}, {
  action: 'vision.paste',
  key: Key.ctrl('v'),
  available: ALWAYS,
}, {
  action: 'attachments.focus',
  key: Key.alt('a'),
  available: WITH_ATTACHMENTS,
}, {
  action: 'attachments.remove-last',
  key: Key.alt(Key.backspace),
  available: WITH_ATTACHMENTS,
}, {
  action: 'details.toggle',
  key: Key.ctrl('o'),
  available: ALWAYS,
}, {
  action: 'reasoning.cycle',
  key: Key.shift(Key.tab),
  available: ALWAYS,
}, {
  action: 'turn.queue',
  key: Key.tab,
  available: WHEN_WORKING,
}]

/** Normalize raw press/repeat/release input before emitting one semantic action. */
export function resolveKeymapInput(
  data: string,
  context: KeymapContext,
): KeymapResolution {
  const binding = KEYMAP_BINDINGS.find(candidate => (
    candidate.available(context) && matchesKey(data, candidate.key)
  ))
  if (binding === undefined) return { kind: 'unmatched' }
  if (isKeyRelease(data) || isKeyRepeat(data)) return { kind: 'suppressed' }
  return { kind: 'action', action: binding.action }
}
