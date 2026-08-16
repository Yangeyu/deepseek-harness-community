import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type {
  HistoryEntry,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { TuiState } from '../../src/runtime/controller.ts'
import { sanitizeTerminalText } from '../../src/text.ts'
import { createTheme } from '../../src/presentation/theme.ts'
import { TranscriptComponent } from '../../src/presentation/transcript.ts'

function state(events: HistoryEntry[]): TuiState {
  return {
    sessionId: 'session-test' as SessionSummary['sessionId'],
    cwd: '/workspace',
    running: false,
    connected: true,
    events,
    historyHasMore: false,
    queue: [],
    pendingSubmissions: [],
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
  it('renders durable Vision evidence after its user prompt', () => {
    const transcript = new TranscriptComponent(state([entry({
      event: {
        type: 'user/message',
        seq: 0,
        time: 1_000,
        surfaceOp: 'append',
        data: {
          id: 'message-user',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'What failed?' }],
        },
      },
    }), entry({
      event: {
        type: 'user/message',
        seq: 1,
        time: 1_500,
        surfaceOp: 'append',
        data: {
          id: 'message-vision',
          role: 'user',
          source: {
            kind: 'community-vision',
            analysisId: 'analysis-1',
            provider: 'dashscope-vision',
            model: 'qwen3.7-plus',
            attachments: [{ attachmentId: 'image-1', mediaType: 'image/png', bytes: 10, width: 2, height: 2 }],
            durationMs: 500,
            finishReason: 'stop',
            truncated: false,
          },
          content: [{ type: 'text', text: 'Visible error dialog' }],
        },
      },
    })]), createTheme(false), true, 8)
    transcript.setDetails(true)

    const output = transcript.render(100).join('\n')
    expect(output).toContain('Vision · 1 image · qwen3.7-plus · 500ms')
    expect(output).toContain('dashscope-vision/qwen3.7-plus')
    expect(output.indexOf('What failed?')).toBeLessThan(output.indexOf('Vision · 1 image'))
  })

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

  it('renders deep Markdown headings without exposing their source markers', () => {
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
              id: 'm-deep-heading',
              role: 'assistant',
              source: { kind: 'model', provider: 'p', model: 'm' },
              content: [{ type: 'text', text: '### Production CORS\n\n#### Error middleware' }],
            },
          },
        },
      }),
    ]), createTheme(true), true, 8)

    const output = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(output).toContain('Production CORS')
    expect(output).toContain('Error middleware')
    expect(output).not.toContain('###')
    expect(output.startsWith(' Production CORS')).toBe(true)
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
    expect(collapsed).toContain('› Thought')
    expect(collapsed).not.toContain('thought 1')
    expect(collapsed).toContain('final answer')

    expect(transcript.handlePointer(0, 'move')).toBe(true)
    const hovered = transcript.render(80).join('\n')
    expect(hovered).toContain('\u001b[1m\u001b[36m› Thought\u001b[39m\u001b[22m')
    expect(hovered).not.toContain('\u001b[7m')
    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const expanded = transcript.render(80).join('\n')
    expect(expanded).toContain('⌄ Thought')
    expect(expanded).toContain('thought 1')
    expect(expanded).toContain('\u001b[38;2;148;163;184m')
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

    expect(transcript.render(80).join('\n')).toContain('› Thinking…')
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

  it('renders the complete user prompt as a full-width block without adding a You label', () => {
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

    const rendered = transcript.render(80)
    const output = rendered.join('\n')
    expect(rendered).toHaveLength(3)
    expect(rendered.every(line => line.includes('\u001b[48;2;36;42;58m'))).toBe(true)
    expect(rendered.every(line => visibleWidth(line) === 80)).toBe(true)
    expect(rendered.every(line => line.startsWith('\u001b[48;2;36;42;58m'))).toBe(true)
    expect(output).toContain('\u001b[97m› explain this code\u001b[39m')
    expect(output).not.toContain('You')
  })

  it('renders a local prompt block without transport phases', () => {
    const pending = state([])
    pending.pendingSubmissions = [{
      key: 1,
      text: 'render before the network round trip',
      mode: 'queue',
      intent: 'working',
    }]
    const transcript = new TranscriptComponent(pending, createTheme(true), true, 8)

    const output = transcript.render(80).join('\n')
    expect(output).toContain('\u001b[97m› render before the network round trip\u001b[39m')
    expect(output).not.toContain('Accepted')
    expect(output).not.toContain('Sending')
    expect(output).not.toContain('You')
  })

  it('hands a local prompt to a visible queue row without hiding context placement', () => {
    const queued = state([])
    queued.pendingSubmissions = [{
      key: 1,
      text: 'queued once',
      mode: 'queue',
      intent: 'working',
      rpcId: 'rpc-queued' as never,
    }]
    queued.queue = [{
      id: 'message-queued',
      placement: 'queued',
      message: {
        id: 'message-queued',
        role: 'user',
        source: { kind: 'user', rpcId: 'rpc-queued' },
        content: [{ type: 'text', text: 'queued once' }],
      },
    }] as TuiState['queue']

    const visible = new TranscriptComponent(queued, createTheme(false), true, 8).render(80).join('\n')
    expect(visible.match(/queued once/g)).toHaveLength(1)
    expect(visible).toContain('Queued')

    queued.queue = [{ ...queued.queue[0]!, placement: 'context' }]
    const context = new TranscriptComponent(queued, createTheme(false), true, 8).render(80).join('\n')
    expect(context).toContain('queued once')
    expect(context).not.toContain('Accepted')
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

  it('expands one tool call on title click to reveal its arguments and result', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1,
          data: {
            turn: 1,
            step: 1,
            callId: 'call-click',
            name: 'search',
            arguments: '{"query":"render details"}',
          },
        },
        view: { for: 'call', view: { card: 'generic', title: 'Search project' } },
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
              id: 'm-tool-click',
              role: 'user',
              source: { kind: 'tool', callId: 'call-click' },
              content: [{
                type: 'tool-result',
                toolCallId: 'call-click',
                content: [{ type: 'text', text: '3 matches' }],
              }],
            },
          },
        },
        view: {
          for: 'result',
          view: { card: 'generic', title: 'Search project', content: [{ type: 'text', text: '3 matches' }] },
        },
      }),
    ]), createTheme(true), true, 8)

    const collapsedOutput = transcript.render(80).join('\n')
    const collapsed = stripTerminalSequences(collapsedOutput)
    expect(collapsed).toContain('› • Search project')
    expect(collapsedOutput).toContain('\u001b[1m\u001b[32m•\u001b[39m\u001b[22m')
    expect(collapsedOutput).toContain('\u001b[38;2;125;211;252mSearch project\u001b[39m')
    expect(collapsed).not.toContain('render details')
    expect(collapsed).not.toContain('3 matches')

    expect(transcript.handlePointer(0, 'move')).toBe(true)
    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ • Search project')
    expect(expanded).toContain('Arguments')
    expect(expanded).toContain('render details')
    expect(expanded).toContain('Result')
    expect(expanded).toContain('3 matches')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    expect(transcript.render(80).join('\n')).not.toContain('3 matches')
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
    expect(plainInitial).toContain('⌄ • Update(src/app.ts)')
    expect(plainInitial).toContain('└ Added 1 line, removed 1 line')
    expect(plainInitial).toContain('3 - const mode = "old"')
    expect(initial).toContain('\u001b[48;2;58;23;31m')
    const initialLines = plainInitial.split('\n')
    const titleColumn = initialLines.find(line => line.includes('⌄ • Update(src/app.ts)'))?.indexOf('•') ?? -1
    const summaryColumn = initialLines.find(line => line.includes('└ Added 1 line'))?.indexOf('└') ?? -1
    const removedColumn = initialLines.find(line => line.includes('3 - const mode'))?.indexOf('3 -') ?? -1
    expect(titleColumn).toBeGreaterThanOrEqual(0)
    expect(summaryColumn).toBe(titleColumn)
    expect(removedColumn).toBeGreaterThan(summaryColumn)
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
    expect(collapsed).toContain('› • Update(src/app.ts)')
    expect(collapsed).not.toContain('const mode')
  })

  it('wraps long changed lines without hiding their tail', () => {
    const longLine = 'A long changed line keeps wrapping until the unique VISIBLE_TAIL remains readable.'
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1,
          data: { turn: 1, step: 1, callId: 'call-long-diff', name: 'write', arguments: '{}' },
        },
        view: {
          for: 'call',
          view: { card: 'diff', title: 'Write notes.txt', diffs: [{ path: 'notes.txt', oldText: null, newText: longLine }] },
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
              id: 'm-long-diff',
              role: 'user',
              source: { kind: 'tool', callId: 'call-long-diff' },
              content: [{ type: 'tool-result', toolCallId: 'call-long-diff', content: [{ type: 'text', text: 'done' }] }],
            },
          },
        },
        view: {
          for: 'result',
          view: { card: 'diff', title: 'Write notes.txt', diffs: [{ path: 'notes.txt', oldText: null, newText: longLine }] },
        },
      }),
    ]), createTheme(true), true, 8)

    const output = transcript.render(32)
    const plain = stripTerminalSequences(output.join('\n'))
    const addedRows = output.filter(line => line.includes('\u001b[48;2;12;48;28m'))
    expect(plain).toContain('VISIBLE_TAIL')
    expect(addedRows.length).toBeGreaterThan(1)
    expect(output.every(line => visibleWidth(line) === 32)).toBe(true)
  })

  it('renders one durable command lifecycle row with its settled result', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'command/run',
          seq: 1,
          time: 1_000,
          data: {
            commandId: 'command-1',
            name: 'compact',
            args: ' focus on tests',
            source: { kind: 'user' },
          },
        },
      }),
      entry({
        event: {
          type: 'command/done',
          seq: 2,
          time: 1_250,
          data: {
            commandId: 'command-1',
            kind: 'success',
            text: 'Context compacted',
          },
        },
      }),
    ]), createTheme(false), true, 8)

    const output = transcript.render(80).join('\n')
    expect(output).toContain('Command')
    expect(output).toContain('/compact focus on tests')
    expect(output).toContain('Context compacted')
    expect(output.match(/Context compacted/gu)).toHaveLength(1)
  })
})

describe('sanitizeTerminalText', () => {
  it('removes terminal control bytes while preserving newlines and tabs', () => {
    expect(sanitizeTerminalText('safe\u001b]52;clipboard\u0007\nnext\tcell'))
      .toBe('safe]52;clipboard\nnext\tcell')
  })
})
