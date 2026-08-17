import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { RewindDialog, RewindPointDialog } from '../../src/presentation/rewind/index.ts'
import { createTheme } from '../../src/presentation/theme.ts'
import type { RewindPlan } from '../../src/rewind/index.ts'

function plan(overrides: Partial<RewindPlan> = {}): RewindPlan {
  return {
    planId: 'plan-1',
    pointId: 'point-1',
    sessionId: 'session-1',
    turn: 2,
    input: { text: 'fix the parser', attachments: [] },
    createdAt: Date.now(),
    previousTurnEndSeq: 15,
    codeScope: 'backward',
    state: 'safe',
    files: [
      { path: 'src/parser.ts', state: 'safe', added: 4, removed: 2 },
    ],
    participants: [{ id: 'memory', label: 'Memory', changes: 1, state: 'safe' }],
    ...overrides,
  }
}

describe('RewindDialog', () => {
  it('shows source-attributed files and defaults a safe plan to Restore', () => {
    const confirm = vi.fn()
    const cancel = vi.fn()
    const dialog = new RewindDialog(plan(), () => 24, createTheme(false), confirm, cancel)

    const output = dialog.render(80).join('\n')
    expect(output).toContain('Choose what to restore')
    expect(output).toContain('fix the parser')
    expect(output).toContain('1 source-attributed file is included')
    expect(output).toContain('● src/parser.ts')
    expect(output).toContain('1 memory update will be reverted when code state is restored')
    expect(output).toContain('› 1. Restore code and conversation')

    dialog.handleInput('\r')
    expect(confirm).toHaveBeenCalledWith('code-and-conversation')
    expect(cancel).not.toHaveBeenCalled()
    expect(dialog.render(40).every(line => visibleWidth(line) <= 40)).toBe(true)
  })

  it('keeps conversation-only Rewind available when code restore is blocked', () => {
    const confirm = vi.fn()
    const cancel = vi.fn()
    const dialog = new RewindDialog(plan({
      state: 'conflict',
      files: [{ path: 'src/parser.ts', state: 'conflict', reason: 'A later change overlaps the AI edit.' }],
    }), () => 24, createTheme(false), confirm, cancel)

    const output = dialog.render(80).join('\n')
    expect(output).toContain('1. Restore code and conversation (unavailable)')
    expect(output).toContain('› 2. Restore conversation only')
    dialog.handleInput('\r')
    expect(confirm).toHaveBeenCalledWith('conversation-only')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps actions visible and pages every affected path in a short terminal', () => {
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `src/feature-${String(index).padStart(2, '0')}.ts`,
      state: 'safe' as const,
    }))
    const dialog = new RewindDialog(plan({ files }), () => 10, createTheme(false), vi.fn(), vi.fn())

    let output = dialog.render(32)
    expect(output.length).toBeLessThanOrEqual(10)
    expect(output.join('\n')).toContain('1. Restore code')
    for (let page = 0; page < 20; page += 1) {
      dialog.handleInput('\u001b[6~')
      output = dialog.render(32)
    }
    expect(output.length).toBeLessThanOrEqual(10)
    expect(output.join('\n')).toContain('feature-11.ts')
    expect(output.join('\n')).toContain('1. Restore code')
    expect(output.every(line => visibleWidth(line) <= 32)).toBe(true)
  })

  it('selects code-only restore as an independent action', () => {
    const confirm = vi.fn()
    const dialog = new RewindDialog(plan(), () => 24, createTheme(false), confirm, vi.fn())

    dialog.handleInput('3')
    dialog.handleInput('\r')

    expect(confirm).toHaveBeenCalledWith('code-only')
  })
})
describe('RewindPointDialog', () => {
  it('opens on the newest point and reports AI-attributed counts', () => {
    const select = vi.fn()
    const cancel = vi.fn()
    const summaries = [
      { pointId: 'one', sessionId: 'session-1', turn: 1, prompt: 'first', imageCount: 0, createdAt: 1, workspaceFiles: 0, unsupportedFiles: 0, participants: [] },
      { pointId: 'two', sessionId: 'session-1', turn: 2, prompt: 'second', imageCount: 2, createdAt: 2, workspaceFiles: 2, unsupportedFiles: 0, participants: [{ id: 'memory', label: 'Memory', changes: 1, state: 'safe' as const }] },
      { pointId: 'three', sessionId: 'session-1', turn: 3, prompt: 'third', imageCount: 0, createdAt: 3, workspaceFiles: 0, unsupportedFiles: 1, participants: [] },
    ]
    const dialog = new RewindPointDialog(summaries, undefined, () => 20, createTheme(false), select, cancel)

    expect(dialog.render(80).join('\n')).toContain('› third')
    expect(dialog.render(80).join('\n')).toContain('No AI file edits · 1 unsupported')
    dialog.handleInput('\u001b[A')
    expect(dialog.render(80).join('\n')).toContain('2 AI-edited files this turn · 2 images · 1 memory update')
    dialog.handleInput('\r')
    expect(select).toHaveBeenCalledWith(summaries[1])

    dialog.handleInput('\u001b')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('renders an empty file impact below actionable secondary text', () => {
    const summaries = [
      { pointId: 'one', sessionId: 'session-1', turn: 1, prompt: 'first', imageCount: 0, createdAt: 1, workspaceFiles: 0, unsupportedFiles: 0, participants: [] },
    ]
    const output = new RewindPointDialog(
      summaries,
      undefined,
      () => 20,
      createTheme(true),
      vi.fn(),
      vi.fn(),
    ).render(80).join('\n')

    expect(output).toContain('\u001b[38;2;148;163;184mNo AI file edits\u001b[39m')
    expect(output).not.toContain('\u001b[38;2;188;198;214mNo AI file edits\u001b[39m')
  })
})
