import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { RewindCheckpointDialog, RewindDialog } from '../../src/presentation/dialogs.ts'
import { createTheme } from '../../src/presentation/theme.ts'

describe('RewindDialog', () => {
  it('shows the checkpoint diff and requires an explicit confirmation', () => {
    const confirm = vi.fn()
    const cancel = vi.fn()
    const dialog = new RewindDialog({
      checkpointId: 'checkpoint-1',
      sessionId: 'session-1',
      turn: 2,
      prompt: 'fix the parser',
      createdAt: Date.now(),
      previousTurnEndSeq: 15,
      files: [
        { path: 'src/parser.ts', added: 4, removed: 2 },
        { path: 'fixtures/input.bin' },
      ],
      currentTree: 'tree-1',
      memoryMutations: [{
        id: 'memory-1',
        sourceSessionId: 'session-1',
        sourceTurn: 2,
        scope: 'project',
        summary: 'Use focused checks.',
        operation: 'write',
        files: [],
        createdAt: Date.now(),
      }],
    }, createTheme(false), confirm, cancel)

    const output = dialog.render(80).join('\n')
    expect(output).toContain('Confirm you want to restore')
    expect(output).toContain('fix the parser')
    expect(output).toContain('2 changed files will be restored')
    expect(output).toContain('1 memory update will be reverted')
    expect(output).toContain('1. Restore workspace, memory, and conversation')

    dialog.handleInput('\u001b[B')
    dialog.handleInput('\r')
    expect(cancel).toHaveBeenCalledOnce()
    expect(confirm).not.toHaveBeenCalled()

    expect(dialog.render(40).every(line => visibleWidth(line) <= 40)).toBe(true)
  })
})

describe('RewindCheckpointDialog', () => {
  it('opens on the newest checkpoint and supports bounded up/down selection', () => {
    const select = vi.fn()
    const cancel = vi.fn()
    const summaries = [
      { checkpointId: 'one', sessionId: 'session-1', turn: 1, prompt: 'first', createdAt: 1, turnChangedFiles: 0 },
      { checkpointId: 'two', sessionId: 'session-1', turn: 2, prompt: 'second', createdAt: 2, turnChangedFiles: 2, memoryUpdates: 1 },
      { checkpointId: 'three', sessionId: 'session-1', turn: 3, prompt: 'third', createdAt: 3 },
    ]
    const dialog = new RewindCheckpointDialog(summaries, undefined, () => 20, createTheme(false), select, cancel)

    expect(dialog.render(80).join('\n')).toContain('› third')
    dialog.handleInput('\u001b[A')
    expect(dialog.render(80).join('\n')).toContain('1 memory update')
    dialog.handleInput('\r')
    expect(select).toHaveBeenCalledWith(summaries[1])

    dialog.handleInput('\u001b')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('preserves selection when changed-file counts arrive asynchronously', () => {
    const dialog = new RewindCheckpointDialog([
      { checkpointId: 'one', sessionId: 'session-1', turn: 1, prompt: 'first', createdAt: 1 },
      { checkpointId: 'two', sessionId: 'session-1', turn: 2, prompt: 'second', createdAt: 2 },
    ], 'one', () => 20, createTheme(false), vi.fn(), vi.fn())

    dialog.setSummaries([
      { checkpointId: 'one', sessionId: 'session-1', turn: 1, prompt: 'first', createdAt: 1, turnChangedFiles: 0 },
      { checkpointId: 'two', sessionId: 'session-1', turn: 2, prompt: 'second', createdAt: 2, turnChangedFiles: 3 },
    ])

    const output = dialog.render(80).join('\n')
    expect(output).toContain('› first')
    expect(output).toContain('No code changes')
  })
})
