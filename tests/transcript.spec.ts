import { describe, expect, it } from 'vitest'
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
    expect(output).toContain('\u001b[1m›\u001b[22m explain this code')
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
})

describe('sanitizeTerminalText', () => {
  it('removes terminal control bytes while preserving newlines and tabs', () => {
    expect(sanitizeTerminalText('safe\u001b]52;clipboard\u0007\nnext\tcell'))
      .toBe('safe]52;clipboard\nnext\tcell')
  })
})
