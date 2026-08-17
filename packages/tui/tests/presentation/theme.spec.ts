import { describe, expect, it } from 'vitest'
import { createTheme } from '../../src/presentation/theme.ts'

describe('TUI theme contrast', () => {
  it('uses explicit foreground levels instead of terminal-dependent dim styling', () => {
    const theme = createTheme(true)

    expect(theme.secondary('hint')).toBe('\u001b[38;2;188;198;214mhint\u001b[39m')
    expect(theme.dim('hint')).toBe('\u001b[38;2;164;176;194mhint\u001b[39m')
    expect(theme.dim('hint')).not.toBe(theme.secondary('hint'))
    expect(theme.dim('hint')).not.toContain('\u001b[2m')
    expect(theme.surfaceBorder('│')).toBe('\u001b[38;2;100;116;139m│\u001b[39m')
  })
})
