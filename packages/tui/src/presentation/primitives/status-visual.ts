import type { TuiTheme } from './theme.ts'

export type StatusTone = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface StatusVisual {
  readonly glyph: string
  readonly paint: (text: string) => string
  readonly bold: boolean
}

/** Feature-neutral visual vocabulary for monotonic work states. */
export function statusVisual(status: StatusTone, theme: TuiTheme): StatusVisual {
  switch (status) {
    case 'pending': return { glyph: '◦', paint: theme.warning, bold: false }
    case 'running': return { glyph: '◦', paint: theme.warning, bold: false }
    case 'completed': return { glyph: '•', paint: theme.success, bold: true }
    case 'failed': return { glyph: '×', paint: theme.error, bold: false }
    case 'interrupted': return { glyph: '!', paint: theme.warning, bold: false }
  }
}
