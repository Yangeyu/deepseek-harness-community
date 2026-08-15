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
