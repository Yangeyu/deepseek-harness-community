import {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type KeyId,
} from '@earendil-works/pi-tui'
import type {
  KeyPhase,
  PointerAction,
  TerminalGesture,
  TerminalKey,
} from '../../presentation/shell/input/gesture.ts'

interface MouseReport {
  button: number
  x: number
  y: number
  release: boolean
}

const KEY_IDENTITIES: readonly [TerminalKey, KeyId][] = [
  ['escape', Key.escape],
  ['ctrl-c', Key.ctrl('c')],
  ['ctrl-v', Key.ctrl('v')],
  ['alt-a', Key.alt('a')],
  ['alt-backspace', Key.alt(Key.backspace)],
  ['ctrl-o', Key.ctrl('o')],
  ['shift-tab', Key.shift(Key.tab)],
  ['tab', Key.tab],
  ['page-up', Key.pageUp],
  ['page-down', Key.pageDown],
  ['up', Key.up],
  ['down', Key.down],
  ['left', Key.left],
  ['right', Key.right],
  ['enter', Key.enter],
  ['space', Key.space],
  ['delete', Key.delete],
  ['backspace', Key.backspace],
  ['ctrl-u', Key.ctrl('u')],
  ['ctrl-d', Key.ctrl('d')],
  ['/', '/'],
  ['[', '['],
  [']', ']'],
  ['c', 'c'],
  ['v', 'v'],
  ['N', Key.shift('n')],
  ['e', 'e'],
  ['g', 'g'],
  ['G', Key.shift('g')],
  ['h', 'h'],
  ['j', 'j'],
  ['J', Key.shift('j')],
  ['k', 'k'],
  ['K', Key.shift('k')],
  ['l', 'l'],
  ['n', 'n'],
  ['r', 'r'],
  ['R', Key.shift('r')],
  ['s', 's'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['4', '4'],
  ['5', '5'],
  ['6', '6'],
  ['7', '7'],
  ['8', '8'],
  ['9', '9'],
]

/** Decode one SGR mouse report, leaving keyboard input untouched. */
export function parseMouseReport(data: string): MouseReport | undefined {
  // oxlint-disable-next-line no-control-regex -- ESC is the SGR mouse-report prefix.
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data)
  if (match === null) return undefined
  return {
    button: Number.parseInt(match[1] ?? '', 10),
    x: Number.parseInt(match[2] ?? '', 10) - 1,
    y: Number.parseInt(match[3] ?? '', 10) - 1,
    release: match[4] === 'm',
  }
}

export function resolveMouseAction(report: MouseReport): PointerAction {
  const point = { x: report.x, y: report.y }
  if (report.release) return { kind: 'release', ...point }
  if ((report.button & 64) !== 0) {
    return { kind: 'wheel', direction: (report.button & 1) === 0 ? -1 : 1, ...point }
  }
  if ((report.button & 32) !== 0) {
    const button = report.button & 3
    if (button === 0) return { kind: 'drag', ...point }
    if (button === 3) return { kind: 'move', ...point }
    return { kind: 'ignored', ...point }
  }
  return (report.button & 3) === 0
    ? { kind: 'press', ...point }
    : { kind: 'ignored', ...point }
}

/** The only raw escape-sequence decoder used by the terminal application. */
export function decodeTerminalInput(data: string): TerminalGesture {
  const mouse = parseMouseReport(data)
  if (mouse !== undefined) return { kind: 'pointer', action: resolveMouseAction(mouse) }
  const phase: KeyPhase = isKeyRelease(data) ? 'release' : isKeyRepeat(data) ? 'repeat' : 'press'
  const key = KEY_IDENTITIES.find(([, id]) => matchesKey(data, id))?.[0] ?? 'other'
  return { kind: 'key', key, phase, raw: data }
}
