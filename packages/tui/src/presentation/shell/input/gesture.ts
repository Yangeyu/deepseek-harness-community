/** Keyboard identities understood by the fixed application binding table. */
export type TerminalKey =
  | 'escape'
  | 'ctrl-c'
  | 'ctrl-v'
  | 'alt-a'
  | 'alt-backspace'
  | 'ctrl-o'
  | 'shift-tab'
  | 'tab'
  | 'page-up'
  | 'page-down'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'space'
  | 'delete'
  | 'backspace'
  | 'ctrl-u'
  | 'ctrl-d'
  | '/'
  | '['
  | ']'
  | 'c'
  | 'v'
  | 'N'
  | 'e'
  | 'g'
  | 'G'
  | 'h'
  | 'j'
  | 'J'
  | 'k'
  | 'K'
  | 'l'
  | 'n'
  | 'r'
  | 'R'
  | 's'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'other'

export type KeyPhase = 'press' | 'repeat' | 'release'

export type PointerAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'press'; x: number; y: number }
  | { kind: 'drag'; x: number; y: number }
  | { kind: 'release'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; direction: -1 | 1 }
  | { kind: 'ignored'; x: number; y: number }

/** Decoder output. Raw data remains opaque and is forwarded only on passthrough. */
export type TerminalGesture =
  | { readonly kind: 'key'; readonly key: TerminalKey; readonly phase: KeyPhase; readonly raw: string }
  | { readonly kind: 'pointer'; readonly action: PointerAction }
