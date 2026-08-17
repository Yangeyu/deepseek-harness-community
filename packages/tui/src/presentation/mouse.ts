/** Enable SGR mouse coordinates and pointer-motion reports for the presentation layer. */
export const ENABLE_MOUSE_TRACKING = '\u001b[?1000h\u001b[?1003h\u001b[?1006h'

/** Restore normal terminal-owned pointer behavior. */
export const DISABLE_MOUSE_TRACKING = '\u001b[?1006l\u001b[?1003l\u001b[?1000l'

/** One decoded SGR mouse report using zero-based terminal coordinates. */
export interface MouseReport {
  button: number
  x: number
  y: number
  release: boolean
}

/** Pointer intent resolved from one terminal mouse report. */
export type MouseAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'press'; x: number; y: number }
  | { kind: 'drag'; x: number; y: number }
  | { kind: 'release'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; direction: -1 | 1 }
  | { kind: 'ignored'; x: number; y: number }

/** Decode an SGR mouse report, leaving all keyboard input untouched. */
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

/** Resolve terminal button bits before application behavior is selected. */
export function resolveMouseAction(report: MouseReport): MouseAction {
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
