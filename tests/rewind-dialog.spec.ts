import { describe, expect, it, vi } from 'vitest'
import { RewindDialog } from '../src/dialogs.ts'
import { createTheme } from '../src/theme.ts'

describe('RewindDialog', () => {
  it('shows the checkpoint diff and requires an explicit confirmation', () => {
    const confirm = vi.fn()
    const cancel = vi.fn()
    const dialog = new RewindDialog({
      checkpointId: 'checkpoint-1',
      sessionId: 'session-1',
      turn: 2,
      prompt: 'fix the parser',
      previousTurnEndSeq: 15,
      files: [
        { path: 'src/parser.ts', added: 4, removed: 2 },
        { path: 'fixtures/input.bin' },
      ],
      currentTree: 'tree-1',
    }, createTheme(false), confirm, cancel)

    const output = dialog.render(80).join('\n')
    expect(output).toContain('Rewind Last Turn')
    expect(output).toContain('fix the parser')
    expect(output).toContain('+4 -2  src/parser.ts')
    expect(output).toContain('binary  fixtures/input.bin')

    dialog.handleInput('\u001b[C')
    dialog.handleInput('\r')
    expect(cancel).toHaveBeenCalledOnce()
    expect(confirm).not.toHaveBeenCalled()
  })
})
