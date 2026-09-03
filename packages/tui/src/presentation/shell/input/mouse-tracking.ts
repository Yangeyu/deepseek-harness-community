/** Enable SGR coordinates and passive motion reports for title hover feedback. */
export const ENABLE_MOUSE_TRACKING = '\u001b[?1000h\u001b[?1003h\u001b[?1006h'

/** Restore normal terminal-owned pointer behavior. */
export const DISABLE_MOUSE_TRACKING = '\u001b[?1006l\u001b[?1003l\u001b[?1000l'
