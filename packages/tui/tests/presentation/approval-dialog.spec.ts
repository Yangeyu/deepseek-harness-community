import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalDialog } from '../../src/presentation/dialogs.ts'
import { createTheme } from '../../src/presentation/theme.ts'

describe('ApprovalDialog', () => {
  it('renders a compact readable decision hierarchy at narrow widths', () => {
    const dialog = new ApprovalDialog(
      'edit',
      'The file is outside the conversation workspace and needs broader access.',
      createTheme(false),
      vi.fn(),
      vi.fn(),
    )

    const lines = dialog.render(32)
    const output = stripTerminalSequences(lines.join('\n'))
    const prose = output.replace(/\s+/gu, ' ')
    expect(lines[0]).toBe('Permission required · edit')
    expect(prose).toContain('outside the conversation workspace')
    expect(output).toContain('› 1. Allow once')
    expect(output).toContain('2. Reject and continue')
    expect(prose).toContain('Reject declines only this tool')
    expect(prose).toContain('Esc/Ctrl+C interrupt task')
    expect(lines.every(line => visibleWidth(line) <= 32)).toBe(true)
  })

  it('keeps selection compact and resolves the highlighted decision', () => {
    const select = vi.fn()
    const dialog = new ApprovalDialog('shell', undefined, createTheme(false), select, vi.fn())

    dialog.handleInput('\u001b[B')
    expect(dialog.render(80).join('\n')).toContain('› 2. Reject and continue')
    dialog.handleInput('\r')

    expect(select).toHaveBeenCalledWith('rejected')
  })

  it('uses stable secondary text instead of terminal-dependent dim styling', () => {
    const dialog = new ApprovalDialog(
      'edit',
      'Broader access is required.',
      createTheme(true),
      vi.fn(),
      vi.fn(),
    )

    const output = dialog.render(80).join('\n')
    expect(output).toContain('\u001b[38;2;188;198;214m')
    expect(output).not.toContain('\u001b[2m')
    expect(stripTerminalSequences(output)).toContain('Broader access is required.')
  })

  it('keeps Escape as task interruption rather than rejection', () => {
    const select = vi.fn()
    const cancel = vi.fn()
    const dialog = new ApprovalDialog('shell', undefined, createTheme(false), select, cancel)

    dialog.handleInput('\u001b')

    expect(cancel).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
  })
})
