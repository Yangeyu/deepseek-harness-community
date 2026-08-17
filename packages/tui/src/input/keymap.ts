import {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type KeyId,
} from '@earendil-works/pi-tui'

/** Stable keymap identifiers persisted in user settings. */
export const KEYMAP_PRESET_IDS = ['standard', 'legacy'] as const
export type KeymapPreset = typeof KEYMAP_PRESET_IDS[number]

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

export interface KeymapPresetOption {
  id: KeymapPreset
  label: string
  description: string
}

export interface KeymapBindingSummary {
  action: KeymapAction
  label: string
  keys: readonly string[]
}

export type KeymapResolution =
  | { kind: 'action'; action: KeymapAction }
  | { kind: 'suppressed' }
  | { kind: 'unmatched' }

interface KeymapBinding {
  action: KeymapAction
  key: KeyId
  label: string
  available(context: KeymapContext): boolean
}

const ALWAYS = (): boolean => true
const WHEN_WORKING = (context: KeymapContext): boolean => context.working
const WITH_ATTACHMENTS = (context: KeymapContext): boolean => context.hasAttachments

const COMMON_BINDINGS: readonly KeymapBinding[] = [{
  action: 'app.cancel-or-exit',
  key: Key.ctrl('c'),
  label: 'Ctrl+C',
  available: ALWAYS,
}, {
  action: 'vision.paste',
  key: Key.ctrl('v'),
  label: 'Ctrl+V',
  available: ALWAYS,
}, {
  action: 'vision.paste',
  key: Key.alt('v'),
  label: 'Alt+V',
  available: ALWAYS,
}, {
  action: 'attachments.focus',
  key: Key.alt('a'),
  label: 'Alt+A',
  available: WITH_ATTACHMENTS,
}, {
  action: 'attachments.remove-last',
  key: Key.alt(Key.backspace),
  label: 'Alt+Backspace',
  available: WITH_ATTACHMENTS,
}, {
  action: 'details.toggle',
  key: Key.ctrl('o'),
  label: 'Ctrl+O',
  available: ALWAYS,
}, {
  action: 'reasoning.cycle',
  key: Key.shift(Key.tab),
  label: 'Shift+Tab',
  available: ALWAYS,
}]

const PRESET_BINDINGS: Readonly<Record<KeymapPreset, readonly KeymapBinding[]>> = {
  standard: [{
    action: 'turn.queue',
    key: Key.tab,
    label: 'Tab',
    available: WHEN_WORKING,
  }],
  legacy: [{
    action: 'turn.queue',
    key: Key.alt(Key.enter),
    label: 'Alt+Enter',
    available: WHEN_WORKING,
  }],
}

const KEYMAP_BINDINGS: Readonly<Record<KeymapPreset, readonly KeymapBinding[]>> = {
  standard: [...PRESET_BINDINGS.standard, ...COMMON_BINDINGS],
  legacy: [...PRESET_BINDINGS.legacy, ...COMMON_BINDINGS],
}

export const KEYMAP_PRESETS: readonly KeymapPresetOption[] = [{
  id: 'standard',
  label: 'Standard',
  description: 'Use Tab to queue while a turn is running and leave Alt+Enter available for multiline input.',
}, {
  id: 'legacy',
  label: 'Legacy',
  description: 'Use Alt+Enter to queue while a turn is running. Idle Alt+Enter still inserts a newline.',
}]

function bindings(preset: KeymapPreset): readonly KeymapBinding[] {
  return KEYMAP_BINDINGS[preset]
}

/** Normalize raw press/repeat/release input before emitting one semantic action. */
export function resolveKeymapInput(
  data: string,
  context: KeymapContext,
  preset: KeymapPreset,
): KeymapResolution {
  const binding = bindings(preset).find(candidate => (
    candidate.available(context) && matchesKey(data, candidate.key)
  ))
  if (binding === undefined) return { kind: 'unmatched' }
  if (isKeyRelease(data) || isKeyRepeat(data)) return { kind: 'suppressed' }
  return { kind: 'action', action: binding.action }
}

/** Human-readable bindings used by configuration and help surfaces. */
export function keymapBindingSummaries(preset: KeymapPreset): readonly KeymapBindingSummary[] {
  const summaries = new Map<KeymapAction, { label: string; keys: string[] }>()
  for (const binding of bindings(preset)) {
    const existing = summaries.get(binding.action)
    if (existing === undefined) summaries.set(binding.action, { label: actionLabel(binding.action), keys: [binding.label] })
    else existing.keys.push(binding.label)
  }
  return [...summaries].map(([action, summary]) => ({ action, ...summary }))
}

export function keymapShortcut(preset: KeymapPreset, action: KeymapAction): string | undefined {
  return bindings(preset).find(binding => binding.action === action)?.label
}

function actionLabel(action: KeymapAction): string {
  switch (action) {
    case 'app.cancel-or-exit': return 'Clear input, cancel task, or exit'
    case 'turn.queue': return 'Queue next message'
    case 'vision.paste': return 'Paste image'
    case 'attachments.focus': return 'Focus attachments'
    case 'attachments.remove-last': return 'Remove latest attachment'
    case 'details.toggle': return 'Toggle details'
    case 'reasoning.cycle': return 'Cycle reasoning effort'
  }
}
