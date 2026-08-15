import { describe, expect, it } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type {
  HistoryEntry,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiState } from '../src/controller.ts'
import { sanitizeTerminalText } from '../src/text.ts'
import { createTheme } from '../src/theme.ts'
import { TranscriptComponent } from '../src/transcript.ts'

function state(events: HistoryEntry[]): TuiState {
  return {
    sessionId: 'session-test' as SessionSummary['sessionId'],
    cwd: '/workspace',
    running: false,
    connected: true,
    events,
    queue: [],
    models: undefined,
    projections: {},
    notice: undefined,
    error: undefined,
  }
}

function entry(value: unknown): HistoryEntry {
  return value as HistoryEntry
}

describe('TranscriptComponent', () => {
  it('renders the final assistant message instead of its superseded stream chunks', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'assistant/chunk',
          seq: 0,
          time: 1,
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } },
        },
      }),
      entry({
        event: {
          type: 'assistant/message',
          seq: 1,
          time: 2,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'm1',
              role: 'assistant',
              source: { kind: 'model', provider: 'p', model: 'm' },
              content: [{ type: 'text', text: 'final answer' }],
            },
          },
        },
      }),
    ]), createTheme(false), true, 8)

    const output = transcript.render(80).join('\n')
    expect(output).toContain('final answer')
    expect(output).not.toContain('partial')
    expect(output).not.toContain('Assistant')
  })

  it('renders assistant Markdown without exposing code-fence syntax', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'assistant/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'm-markdown',
              role: 'assistant',
              source: { kind: 'model', provider: 'p', model: 'm' },
              content: [{
                type: 'text',
                text: '# Result\n\nUse **this path**:\n\n```text\n/workspace/src\n```',
              }],
            },
          },
        },
      }),
    ]), createTheme(false), true, 8)

    const output = transcript.render(80).join('\n')
    expect(output).toContain('Result')
    expect(output).toContain('this path')
    expect(output).toContain('/workspace/src')
    expect(output).not.toContain('# Result')
    expect(output).not.toContain('**')
    expect(output).not.toContain('```')
  })

  it('collapses thinking by default and scrolls within its bounded viewport', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'assistant/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'm-thinking',
              role: 'assistant',
              source: { kind: 'model', provider: 'p', model: 'm' },
              content: [
                { type: 'reasoning', text: Array.from({ length: 8 }, (_, index) => `- thought ${index + 1}`).join('\n') },
                { type: 'text', text: 'final answer' },
              ],
            },
          },
        },
      }),
    ]), createTheme(true), true, 8, 3)

    const collapsed = transcript.render(80).join('\n')
    expect(collapsed).toContain('▸ Thought')
    expect(collapsed).not.toContain('thought 1')
    expect(collapsed).toContain('final answer')

    expect(transcript.handlePointer(0, 'move')).toBe(true)
    const hovered = transcript.render(80).join('\n')
    expect(hovered).toContain('\u001b[1m\u001b[36m▸ Thought\u001b[39m\u001b[22m')
    expect(hovered).not.toContain('\u001b[7m')
    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const expanded = transcript.render(80).join('\n')
    expect(expanded).toContain('▾ Thought')
    expect(expanded).toContain('thought 1')
    expect(expanded).not.toContain('thought 8')
    expect(expanded.split('\n').filter(line => line.includes('│'))).toHaveLength(3)

    expect(transcript.handlePointer(1, 'wheel-down')).toBe(true)
    const scrolled = transcript.render(80).join('\n')
    expect(scrolled).toContain('thought 4')
    expect(scrolled).toContain('thought 6')
    expect(scrolled).not.toContain('thought 8')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    expect(transcript.render(80).join('\n')).not.toContain('thought 5')
  })

  it('follows streaming thinking until the user scrolls upward', () => {
    const reasoningChunk = (seq: number, text: string): HistoryEntry => entry({
      event: {
        type: 'assistant/chunk',
        seq,
        time: seq + 1,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text } },
      },
    })
    const events = Array.from({ length: 5 }, (_, index) => reasoningChunk(index, `- stream ${index + 1}\n`))
    const transcript = new TranscriptComponent(state(events), createTheme(false), true, 8, 3)

    expect(transcript.render(80).join('\n')).toContain('▸ Thinking…')
    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const following = transcript.render(80).join('\n')
    expect(following).toContain('stream 5')
    expect(following).not.toContain('stream 1')

    expect(transcript.handlePointer(1, 'wheel-up')).toBe(true)
    transcript.setState(state([...events, reasoningChunk(5, '- stream 6\n')]))
    const paused = transcript.render(80).join('\n')
    expect(paused).toContain('stream 1')
    expect(paused).not.toContain('stream 6')
  })

  it('highlights the complete user prompt without adding a You label', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'user/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            id: 'm-user',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'explain this code' }],
          },
        },
      }),
    ]), createTheme(true), true, 8)

    const output = transcript.render(80).join('\n')
    expect(output).toContain('\u001b[1m\u001b[33m› explain this code\u001b[39m\u001b[22m')
    expect(output).not.toContain('You')
  })

  it('uses tool-owned presentation intent and expands bounded result output', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1,
          data: { turn: 1, step: 1, callId: 'call-1', name: 'opaque-name', arguments: '{}' },
        },
        view: { for: 'call', view: { card: 'terminal', title: 'pnpm test', cwd: '/workspace' } },
      }),
      entry({
        event: {
          type: 'tool/result',
          seq: 1,
          time: 2,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'm2',
              role: 'user',
              source: { kind: 'tool', callId: 'call-1' },
              content: [{
                type: 'tool-result',
                toolCallId: 'call-1',
                content: [{ type: 'text', text: 'fallback' }],
              }],
            },
          },
        },
        view: { for: 'result', view: { card: 'terminal', output: 'passed', exitCode: 0 } },
      }),
    ]), createTheme(false), true, 8)
    transcript.setDetails(true)

    const output = transcript.render(80).join('\n')
    expect(output).toContain('$ pnpm test')
    expect(output).toContain('passed')
    expect(output).toContain('[exit 0]')
    expect(output).not.toContain('opaque-name')
  })

  it('shows applied file diffs by default and scrolls them with the pointer', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1,
          data: { turn: 1, step: 1, callId: 'call-diff', name: 'edit', arguments: '{}' },
        },
        view: {
          for: 'call',
          view: { card: 'diff', title: 'Edit src/app.ts', diffs: [{ path: 'src/app.ts', oldText: 'stale', newText: 'planned' }] },
        },
      }),
      entry({
        event: {
          type: 'tool/result',
          seq: 1,
          time: 2,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'm-diff',
              role: 'user',
              source: { kind: 'tool', callId: 'call-diff' },
              content: [{ type: 'tool-result', toolCallId: 'call-diff', content: [{ type: 'text', text: 'done' }] }],
            },
          },
        },
        view: {
          for: 'result',
          view: {
            card: 'diff',
            title: 'Edit src/app.ts',
            diffs: [{
              path: 'src/app.ts',
              oldText: 'const one = 1\nconst two = 2\nconst mode = "old"\nreturn mode\nend()',
              newText: 'const one = 1\nconst two = 2\nconst mode = "new"\nreturn mode\nend()',
            }],
          },
        },
      }),
    ]), createTheme(true), true, 3)
    transcript.setDiffLineStarts(new Map([['call-diff:diff', [1]]]))

    const initial = transcript.render(80).join('\n')
    const plainInitial = stripTerminalSequences(initial)
    expect(plainInitial).toContain('● Update(src/app.ts)')
    expect(plainInitial).toContain('└ Added 1 line, removed 1 line')
    expect(plainInitial).toContain('3 - const mode = "old"')
    expect(initial).toContain('\u001b[48;2;58;23;31m')
    expect(plainInitial).not.toContain('stale')
    expect(plainInitial).not.toContain('"new"')

    expect(transcript.handlePointer(1, 'wheel-down')).toBe(true)
    const scrolled = transcript.render(80).join('\n')
    expect(stripTerminalSequences(scrolled)).toContain('3 + const mode = "new"')
    expect(scrolled).toContain('\u001b[48;2;12;48;28m')
    expect(transcript.handlePointer(0, 'move')).toBe(true)
    expect(transcript.render(80).join('\n')).not.toContain('\u001b[7m')
    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('▸ ● Update(src/app.ts)')
    expect(collapsed).not.toContain('const mode')
  })
})

describe('sanitizeTerminalText', () => {
  it('removes terminal control bytes while preserving newlines and tabs', () => {
    expect(sanitizeTerminalText('safe\u001b]52;clipboard\u0007\nnext\tcell'))
      .toBe('safe]52;clipboard\nnext\tcell')
  })
})
