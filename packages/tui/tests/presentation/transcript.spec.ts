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
import { buildLifecycleSnapshot } from '../../src/runtime/lifecycle/index.ts'

function state(
  events: HistoryEntry[],
  running = false,
  pendingSubmissions: TuiState['pendingSubmissions'] = [],
): TuiState {
  return {
    sessionId: 'session-test' as SessionSummary['sessionId'],
    cwd: '/workspace',
    running,
    connected: true,
    events,
    historyHasMore: false,
    queue: [],
    pendingSubmissions,
    lifecycle: buildLifecycleSnapshot({
      sessionId: 'session-test',
      generation: 0,
      entries: events,
      sessionRunning: running,
      runtimeActivities: pendingSubmissions.flatMap((submission) => {
        const activity = submission.activity
        return activity?.kind === 'vision'
          ? [{ kind: 'vision' as const, analysisId: activity.analysisId, startedAt: activity.startedAt }]
          : []
      }),
    }),
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
  it('keeps durable user input visible when lifecycle metadata is unavailable', () => {
    const events = [entry({
      event: {
        type: 'user/message',
        seq: 0,
        time: 1_000,
        surfaceOp: 'append',
        data: {
          id: 'message-user',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Do not hide this input' }],
        },
      },
    })]
    const snapshot = state(events)
    const transcript = new TranscriptComponent({
      ...snapshot,
      lifecycle: buildLifecycleSnapshot({
        sessionId: 'session-test',
        generation: 0,
        entries: [],
        sessionRunning: false,
      }),
    }, createTheme(false), true, 8)

    expect(transcript.render(80).join('\n')).toContain('Do not hide this input')
  })

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
            promptId: 'message-user',
            analysisId: 'analysis-1',
            provider: 'bailian',
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
    expect(output).toContain('Worked for 500ms · 1 tool')
    expect(output).toContain('Vision · 1 image · qwen3.7-plus')
    expect(output).toContain('bailian/qwen3.7-plus')
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

  it('settles the Thought indicator while answer text is still streaming', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'assistant/chunk',
          seq: 0,
          time: 1_000,
          data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning' } },
        },
      }),
      entry({
        event: {
          type: 'assistant/chunk',
          seq: 1,
          time: 1_250,
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'streaming answer' } },
        },
      }),
    ], true), createTheme(false), true, 8)

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› Worked for 250ms · 1 thought')
    expect(collapsed).not.toContain('Working')
    expect(collapsed).not.toContain('Thinking…')
    expect(collapsed).toContain('streaming answer')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    expect(stripTerminalSequences(transcript.render(80).join('\n'))).toContain('└─ › • Thought')
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

  it('reuses the rendered document until transcript inputs or width change', () => {
    const events = [entry({
      event: {
        type: 'assistant/message',
        seq: 0,
        time: 1,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'm-cache',
            role: 'assistant',
            source: { kind: 'model', provider: 'p', model: 'm' },
            content: [{ type: 'text', text: 'cached **markdown**' }],
          },
        },
      },
    })]
    const snapshot = state(events)
    const transcript = new TranscriptComponent(snapshot, createTheme(false), true, 8)

    const first = transcript.render(80)
    expect(transcript.render(80)).toBe(first)

    transcript.setState({ ...snapshot, projections: { ...snapshot.projections } })
    expect(transcript.render(80)).toBe(first)
    expect(transcript.render(72)).not.toBe(first)

    transcript.setState(state([...events, entry({
      event: {
        type: 'turn/end',
        seq: 1,
        time: 2,
        data: { reason: { kind: 'max-tokens' } },
      },
    })]))
    expect(transcript.render(80)).not.toBe(first)
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

  it('collapses activity by default and scrolls expanded thinking within its bounded viewport', () => {
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
    expect(collapsed).toContain('› Worked · 1 thought')
    expect(collapsed).not.toContain('thought 1')
    expect(collapsed).toContain('final answer')

    expect(transcript.handlePointer(0, 'move')).toBe(true)
    const hovered = transcript.render(80)
    expect(hovered.join('\n')).toContain('\u001b[1m\u001b[36m› Worked · 1 thought\u001b[39m\u001b[22m')
    expect(transcript.handlePointer(0, 'move')).toBe(false)
    expect(transcript.render(80)).toBe(hovered)
    expect(transcript.handlePointer(2, 'move')).toBe(true)

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const activity = transcript.render(80).join('\n')
    expect(stripTerminalSequences(activity)).toContain('└─ › • Thought')
    expect(activity).not.toContain('thought 1')

    expect(transcript.handlePointer(1, 'click')).toBe(true)
    const expanded = transcript.render(80).join('\n')
    expect(stripTerminalSequences(expanded)).toContain('⌄ • Thought')
    expect(expanded).toContain('thought 1')
    expect(expanded).toContain('\u001b[38;2;188;198;214m')
    expect(expanded).not.toContain('thought 8')
    expect(expanded.split('\n').filter(line => line.includes('│'))).toHaveLength(3)

    expect(transcript.handlePointer(2, 'wheel-down')).toBe(true)
    const scrolled = transcript.render(80).join('\n')
    expect(scrolled).toContain('thought 2')
    expect(scrolled).toContain('thought 4')
    expect(scrolled).not.toContain('thought 5')

    expect(transcript.handlePointer(1, 'click')).toBe(true)
    expect(transcript.render(80).join('\n')).not.toContain('thought 5')
  })

  it('preserves manual Activity disclosure when older execution children are prepended', () => {
    const tool = entry({
      event: {
        type: 'tool/call',
        seq: 2,
        time: 1_200,
        data: { turn: 1, step: 1, callId: 'call-visible', name: 'read', arguments: '{}' },
      },
      view: { for: 'call', view: { card: 'generic', title: 'Read project' } },
    })
    const transcript = new TranscriptComponent(state([tool], true), createTheme(false), true, 8)

    transcript.render(80)
    expect(transcript.handlePointer(0, 'click')).toBe(true)
    expect(stripTerminalSequences(transcript.render(80).join('\n'))).toContain('└─ › ◦ Read project')

    transcript.setState(state([
      entry({
        event: {
          type: 'assistant/chunk',
          seq: 1,
          time: 1_100,
          data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'earlier reasoning' } },
        },
      }),
      tool,
    ], true))
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ Working · 1 thought · 1 tool')
    expect(expanded).toContain('├─ › ◦ Thinking…')
    expect(expanded).toContain('└─ › ◦ Read project')
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
    const transcript = new TranscriptComponent(state(events, true), createTheme(false), true, 8, 3)

    expect(transcript.render(80).join('\n')).toContain('› Working · 1 thought · Thinking…')
    expect(transcript.handlePointer(0, 'click')).toBe(true)
    expect(stripTerminalSequences(transcript.render(80).join('\n'))).toContain('└─ › ◦ Thinking…')
    expect(transcript.handlePointer(1, 'click')).toBe(true)
    const following = transcript.render(80).join('\n')
    expect(following).toContain('stream 5')
    expect(following).not.toContain('stream 1')

    expect(transcript.handlePointer(2, 'wheel-up')).toBe(true)
    transcript.setState(state([...events, reasoningChunk(5, '- stream 6\n')], true))
    const paused = transcript.render(80).join('\n')
    expect(paused).toContain('stream 2')
    expect(paused).not.toContain('stream 6')
  })

  it('settles unfinished activity when the turn reaches its output limit', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'assistant/chunk',
          seq: 0,
          time: 1_000,
          data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'unfinished reasoning' } },
        },
      }),
      entry({
        event: {
          type: 'tool/call',
          seq: 1,
          time: 1_100,
          data: { turn: 1, step: 1, callId: 'call-unfinished', name: 'search', arguments: '{}' },
        },
        view: { for: 'call', view: { card: 'generic', title: 'Search project' } },
      }),
      entry({
        event: {
          type: 'turn/end',
          seq: 2,
          time: 1_250,
          data: { turn: 1, reason: { kind: 'max-tokens' } },
        },
      }),
    ]), createTheme(false), true, 8)

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› Interrupted after 250ms · 1 thought · 1 tool · Search')
    expect(collapsed).not.toContain('Working')
    expect(collapsed).toContain('The response reached the model output limit.')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('├─ › ! Thought interrupted')
    expect(expanded).toContain('└─ › ! Search project')
  })

  it('keeps failed unfinished thinking collapsed while the terminal error remains visible', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'assistant/chunk',
          seq: 0,
          time: 2_000,
          data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'diagnostic reasoning' } },
        },
      }),
      entry({
        event: {
          type: 'turn/end',
          seq: 1,
          time: 2_300,
          data: { turn: 1, reason: { kind: 'error', error: { message: 'model disconnected' } } },
        },
      }),
    ]), createTheme(false), true, 8)

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› Failed after 300ms · 1 thought · Thought failed')
    expect(collapsed).not.toContain('diagnostic reasoning')
    expect(collapsed).toContain('model disconnected')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const activityExpanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(activityExpanded).toContain('⌄ Failed after 300ms · 1 thought · Thought failed')
    expect(activityExpanded).toContain('└─ › × Thought failed')
    expect(activityExpanded).not.toContain('diagnostic reasoning')

    expect(transcript.handlePointer(1, 'click')).toBe(true)
    const thoughtExpanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(thoughtExpanded).toContain('└─ ⌄ × Thought failed')
    expect(thoughtExpanded).toContain('diagnostic reasoning')
  })

  it('applies the global details toggle to both thinking and tools', () => {
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
              id: 'm-details-thinking',
              role: 'assistant',
              source: { kind: 'model', provider: 'p', model: 'm' },
              content: [{ type: 'reasoning', text: 'reasoning details' }],
            },
          },
        },
      }),
      entry({
        event: {
          type: 'tool/call',
          seq: 1,
          time: 2,
          data: { turn: 1, step: 1, callId: 'call-details', name: 'read', arguments: '{"path":"src/app.ts"}' },
        },
        view: { for: 'call', view: { card: 'generic', title: 'Read src/app.ts' } },
      }),
      entry({
        event: {
          type: 'tool/result',
          seq: 2,
          time: 3,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'm-details-result',
              role: 'user',
              source: { kind: 'tool', callId: 'call-details' },
              content: [{ type: 'tool-result', toolCallId: 'call-details', content: [{ type: 'text', text: 'tool details' }] }],
            },
          },
        },
        view: {
          for: 'result',
          view: { card: 'generic', title: 'Read src/app.ts', content: [{ type: 'text', text: 'tool details' }] },
        },
      }),
    ]), createTheme(false), true, 8)

    expect(transcript.render(80).join('\n')).not.toContain('reasoning details')
    transcript.setDetails(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ • Thought')
    expect(expanded).toContain('reasoning details')
    expect(expanded).toContain('⌄ • Read src/app.ts')
    expect(expanded).toContain('tool details')

    transcript.setDetails(false)
    const collapsed = transcript.render(80).join('\n')
    expect(collapsed).not.toContain('reasoning details')
    expect(collapsed).not.toContain('tool details')
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
    const pending = state([], false, [{
      key: 1,
      text: 'render before the network round trip',
      mode: 'queue',
      intent: 'working',
    }])
    const transcript = new TranscriptComponent(pending, createTheme(true), true, 8)

    const output = transcript.render(80).join('\n')
    expect(output).toContain('\u001b[97m› render before the network round trip\u001b[39m')
    expect(output).not.toContain('Accepted')
    expect(output).not.toContain('Sending')
    expect(output).not.toContain('You')
  })

  it('renders Vision loading directly after the optimistic image prompt', () => {
    const pending = state([], false, [{
      key: 1,
      text: 'analyze this image',
      mode: 'queue',
      intent: 'working',
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 1, startedAt: Date.now() - 1_500 },
    }])
    const transcript = new TranscriptComponent(pending, createTheme(false), true, 8)

    const output = transcript.render(80).join('\n')
    expect(output).toContain('› analyze this image')
    expect(output).toContain('Working · 1 tool · Vision')
    expect(output.indexOf('analyze this image')).toBeLessThan(output.indexOf('Working · 1 tool · Vision'))
  })

  it('keeps Vision loading while the durable event takes ownership of the prompt', () => {
    const transitioning = state([entry({
      event: {
        type: 'user/message',
        seq: 0,
        time: 1,
        surfaceOp: 'append',
        data: {
          id: 'message-user',
          role: 'user',
          source: { kind: 'user', rpcId: 'rpc-image' },
          content: [{ type: 'text', text: 'analyze this image' }],
        },
      },
    })], false, [{
      key: 1,
      text: 'analyze this image',
      mode: 'queue',
      intent: 'working',
      rpcId: 'rpc-image' as never,
      durablePromptObserved: true,
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 1, startedAt: Date.now() },
    }])

    const output = new TranscriptComponent(transitioning, createTheme(false), true, 8).render(80).join('\n')
    expect(output.match(/analyze this image/g)).toHaveLength(1)
    expect(output).toContain('Working · 1 tool · Vision')
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

  it('uses the tool-owned operation summary and expands bounded result output', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1,
          data: {
            turn: 1,
            step: 1,
            callId: 'call-1',
            name: 'opaque-name',
            arguments: '{"command":"pnpm test","description":"Run tests"}',
          },
        },
        view: {
          for: 'call',
          view: { card: 'terminal', title: 'pnpm test', description: 'Run tests', cwd: '/workspace' },
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
    expect(output).toContain('Opaque-name · Run tests')
    expect(output).toContain('pnpm test')
    expect(output).toContain('passed')
    expect(output).toContain('[exit 0]')
  })

  it.each([
    {
      surface: 'terminal',
      callView: {
        card: 'terminal' as const,
        title: "python3 - <<'PYEOF'\nimport re\nPYEOF",
        description: 'Inspect dispatch tests',
        cwd: '/workspace',
      },
      operation: 'Bash · Inspect dispatch tests',
    },
    {
      surface: 'generic raw-input',
      callView: {
        card: 'generic' as const,
        title: "python3 - <<'PYEOF'\nimport re\nPYEOF",
        kind: 'execute' as const,
        rawInput: "python3 - <<'PYEOF'\nimport re\nPYEOF",
      },
      operation: 'Bash',
    },
  ])('keeps $surface scripts in details while Activity and tool rows stay semantic', ({ callView, operation }) => {
    const script = callView.title
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1,
          data: {
            turn: 1,
            step: 1,
            callId: 'call-script',
            name: 'bash',
            arguments: JSON.stringify({ command: script, description: 'Inspect dispatch tests' }),
          },
        },
        view: { for: 'call', view: callView },
      }),
    ], true), createTheme(false), true, 8)

    const collapsed = stripTerminalSequences(transcript.render(120).join('\n'))
    expect(collapsed).toContain('› Working · 1 tool · Bash')
    expect(collapsed).not.toContain('Inspect dispatch tests')
    expect(collapsed).not.toContain('python3')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const activity = stripTerminalSequences(transcript.render(120).join('\n'))
    expect(activity).toContain('⌄ Working · 1 tool · Bash')
    expect(activity).toContain(`└─ › ◦ ${operation}`)
    expect(activity).not.toContain('python3')

    expect(transcript.handlePointer(1, 'click')).toBe(true)
    const details = stripTerminalSequences(transcript.render(120).join('\n'))
    expect(details).toContain('Arguments')
    expect(details).toContain("python3 - <<'PYEOF'")
    expect(details).toContain('import re')
  })

  it('reveals a grouped tool operation before its arguments and result', () => {
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
    expect(collapsed).toContain('› Worked for 1ms · 1 tool')
    expect(collapsed).not.toContain('render details')
    expect(collapsed).not.toContain('3 matches')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const activityOutput = transcript.render(80).join('\n')
    const activity = stripTerminalSequences(activityOutput)
    expect(activity).toContain('└─ › • Search project')
    expect(activityOutput).toContain('\u001b[1m\u001b[32m•\u001b[39m\u001b[22m')
    expect(activityOutput).toContain('\u001b[38;2;125;211;252mSearch project\u001b[39m')

    expect(transcript.handlePointer(1, 'click')).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ • Search project')
    expect(expanded).toContain('Arguments')
    expect(expanded).toContain('render details')
    expect(expanded).toContain('Result')
    expect(expanded).toContain('3 matches')

    expect(transcript.handlePointer(1, 'click')).toBe(true)
    expect(transcript.render(80).join('\n')).not.toContain('3 matches')
    expect(transcript.render(32).every(line => visibleWidth(line) === 32)).toBe(true)
  })

  it('keeps failed activity and tool details collapsed until they are opened', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1_000,
          data: {
            turn: 1,
            step: 1,
            callId: 'call-failed',
            name: 'bash',
            arguments: '{"command":"pnpm test","description":"Run tests"}',
          },
        },
        view: {
          for: 'call',
          view: { card: 'terminal', title: 'pnpm test', description: 'Run tests', cwd: '/workspace' },
        },
      }),
      entry({
        event: {
          type: 'tool/result',
          seq: 1,
          time: 1_250,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'm-tool-failed',
              role: 'user',
              source: { kind: 'tool', callId: 'call-failed' },
              content: [{
                type: 'tool-result',
                toolCallId: 'call-failed',
                content: [{ type: 'text', text: '1 test failed' }],
                isError: true,
              }],
            },
            error: { name: 'Error', code: 'TEST_FAILED' },
          },
        },
        view: { for: 'result', view: { card: 'terminal', title: 'pnpm test', output: '1 test failed', exitCode: 1 } },
      }),
    ]), createTheme(false), true, 8)

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› Failed after 250ms · 1 tool · Bash')
    expect(collapsed).not.toContain('Run tests')
    expect(collapsed).not.toContain('pnpm test')
    expect(collapsed).not.toContain('1 test failed')
    expect(collapsed).not.toContain('[exit 1]')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const activity = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(activity).toContain('⌄ Failed after 250ms · 1 tool · Bash')
    expect(activity).toContain('└─ › × Bash · Run tests')
    expect(activity).not.toContain('pnpm test')
    expect(activity).not.toContain('1 test failed')

    expect(transcript.handlePointer(1, 'click')).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('└─ ⌄ × Bash · Run tests')
    expect(expanded).toContain('pnpm test')
    expect(expanded).toContain('1 test failed')
    expect(expanded).toContain('[exit 1]')
  })

  it('shows complete applied file diffs inline and leaves wheel scrolling to the conversation', () => {
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
    expect(plainInitial).toContain('3 + const mode = "new"')
    expect(plainInitial).toContain('5   end()')
    expect(initial).toContain('\u001b[48;2;12;48;28m')
    expect(transcript.handlePointer(1, 'wheel-down')).toBe(false)
    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› • Update(src/app.ts)')
    expect(collapsed).not.toContain('const mode')
  })

  it('keeps a large file edit responsive while preserving full on-demand evidence', () => {
    const newText = Array.from({ length: 201 }, (_, index) => `export const value${index} = ${index}`).join('\n')
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1,
          data: { turn: 1, step: 1, callId: 'call-large-diff', name: 'write', arguments: '{}' },
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
              id: 'm-large-diff',
              role: 'user',
              source: { kind: 'tool', callId: 'call-large-diff' },
              content: [{ type: 'tool-result', toolCallId: 'call-large-diff', content: [] }],
            },
          },
        },
        view: {
          for: 'result',
          view: {
            card: 'diff',
            title: 'Write src/generated.ts',
            diffs: [{ path: 'src/generated.ts', oldText: null, newText }],
          },
        },
      }),
    ]), createTheme(true), true, 8)

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› • Write(src/generated.ts)')
    expect(collapsed).toContain('└ Added 201 lines')
    expect(collapsed).not.toContain('value200')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ • Write(src/generated.ts)')
    expect(expanded).toContain('201 + export const value200 = 200')
  })

  it('keeps failed file evidence top-level but collapsed until it is opened', () => {
    const transcript = new TranscriptComponent(state([
      entry({
        event: {
          type: 'tool/call',
          seq: 0,
          time: 1,
          data: { turn: 1, step: 1, callId: 'call-partial-diff', name: 'edit', arguments: '{}' },
        },
        view: {
          for: 'call',
          view: { card: 'diff', title: 'Edit src/app.ts', diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'planned' }] },
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
              id: 'm-partial-diff',
              role: 'user',
              source: { kind: 'tool', callId: 'call-partial-diff' },
              content: [{
                type: 'tool-result',
                toolCallId: 'call-partial-diff',
                content: [{ type: 'text', text: 'second hunk failed' }],
                isError: true,
              }],
            },
          },
        },
        view: {
          for: 'result',
          view: {
            card: 'diff',
            title: 'Edit src/app.ts',
            diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'partially applied' }],
          },
        },
      }),
    ]), createTheme(false), true, 8)

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› × Update(src/app.ts)')
    expect(collapsed).not.toContain('partially applied')
    expect(collapsed).not.toContain('Failed after')

    expect(transcript.handlePointer(0, 'click')).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ × Update(src/app.ts)')
    expect(expanded).toContain('partially applied')
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
