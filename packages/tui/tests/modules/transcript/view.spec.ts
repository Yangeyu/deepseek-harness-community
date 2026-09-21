import { describe, expect, it, vi } from 'vitest'
import { TranscriptModel } from '../../../src/modules/transcript/model.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { visionEvidenceBlock } from '../../../src/runtime/session/input.ts'
import { state, entry } from './fixtures.ts'
import { Markdown, Text, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/manager.ts'
import { sanitizeTerminalText } from '../../../src/presentation/primitives/text.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import { TranscriptComponent } from '../../../src/modules/transcript/view.ts'
import { ComposerAnchoredLayout } from '../../../src/presentation/shell/layout/composer-layout.ts'
import { TranscriptProcess } from '../../../src/modules/transcript/process.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { AtomicSnapshotStore } from '../../../src/runtime/dispatch/snapshot-store.ts'
import { buildExecutionSnapshot } from '../../../src/runtime/execution/projection/index.ts'

describe('TranscriptComponent', () => {
  it('keeps the same active group when temporary prompts and notices appear or disappear', () => {
    const model = new TranscriptModel(true, 8)
    const running = state([entry({ event: { type: 'tool/call', seq: 0, time: 1_100, data: {
      turn: 1, step: 1, callId: 'read', name: 'read', arguments: '{}',
    } } })], true)
    const transcript = new TranscriptComponent(model.project(running, false), createTheme(true))
    transcript.render(80)
    const row = transcript.animationLine
    expect(row).toBeDefined()

    transcript.setProjection(model.project({
      ...running,
      notice: 'Settings saved.',
      error: 'Another request could not be queued.',
      queue: [{
        id: 'queued-message' as never, placement: 'queued',
        message: { id: 'queued-message' as never, content: [{ type: 'text', text: 'Do this next.' }] },
      }],
      pendingSubmissions: [{ key: 1, text: 'And then this.', mode: 'queue', intent: 'queueing' }],
    }, false))
    transcript.render(80)
    expect(transcript.animationLine).toBe(row)
    transcript.setProjection(model.project(running, false))
    transcript.render(80)
    expect(transcript.animationLine).toBe(row)
  })

  it('keeps failure and retry in the open Activity but stops its shimmer when following content begins', () => {
    const model = new TranscriptModel(true, 8)
    const events = [
      entry({ event: { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } } }),
      entry({ event: { type: 'step/start', seq: 1, time: 1_000, data: { turn: 1, step: 1 } } }),
      entry({ event: { type: 'assistant/message', seq: 2, time: 1_100, surfaceOp: 'append', data: {
        turn: 1, step: 1, stream: [], message: { content: [
          { type: 'reasoning', text: 'Inspect the project.' },
          { type: 'text', text: 'Running **checks**.' },
        ] },
      } } }),
      entry({ event: { type: 'tool/call', seq: 3, time: 1_200, data: {
        turn: 1, step: 1, callId: 'check', name: 'bash', arguments: '{}',
      } } }),
      entry({ event: { type: 'tool/result', seq: 4, time: 1_500, surfaceOp: 'append', data: {
        turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'check' }, content: [
          { type: 'tool-result', isError: true, content: [{ type: 'text', text: 'Check failed.' }] },
        ] },
      } } }),
      entry({ event: { type: 'step/end', seq: 5, time: 1_600, data: { turn: 1, step: 1 } } }),
      entry({ event: { type: 'step/start', seq: 6, time: 1_700, data: { turn: 1, step: 2 } } }),
    ]
    let now = 0
    const transcript = new TranscriptComponent(model.project(state(events, true), true), createTheme(true), 8, () => now)

    const first = [...transcript.render(80)]
    const titleRow = first.findIndex(line => stripTerminalSequences(line).includes('Activity · 1 tool · 1 failed'))
    expect(titleRow).toBeGreaterThan(0)
    expect(transcript.animationLine).toBeDefined()
    expect(first[titleRow]).toContain('\u001b[31m1 failed\u001b[39m')
    const renderMarkdown = vi.spyOn(Markdown.prototype, 'render')
    try {
      now = 1_000
      const next = [...transcript.render(80)]
      expect(next.map(stripTerminalSequences)).toEqual(first.map(stripTerminalSequences))
      expect(next.flatMap((line, index) => line === first[index] ? [] : [index])).toEqual([titleRow])
      expect(renderMarkdown).not.toHaveBeenCalled()
      expect(next[titleRow]).toContain('\u001b[31m1 failed\u001b[39m')
    } finally {
      renderMarkdown.mockRestore()
    }

    events.push(entry({ event: { type: 'tool/call', seq: 7, time: 1_800, data: {
      turn: 1, step: 2, callId: 'retry', name: 'read', arguments: '{}',
    } } }))
    transcript.setProjection(model.project(state([...events], true), true))
    const retry = transcript.render(80)[titleRow]!
    expect(stripTerminalSequences(retry)).toContain('Activity · 2 tools · 1 failed')
    expect(transcript.animationLine).toBe(titleRow)

    expect(transcript.handlePointer(titleRow, 'move', true)).toBe(true)
    const hovered = [...transcript.render(80)]
    expect(transcript.animationLine).toBeUndefined()
    now += 300
    expect(transcript.render(80)).toEqual(hovered)
    transcript.handlePointer(titleRow + 1, 'move', true)
    transcript.render(80)
    expect(transcript.animationLine).toBeDefined()

    const reply = { turn: 1, step: 2, content: [{ type: 'text' as const, text: 'The check needs another approach.' }] }
    transcript.setProjection(model.project(state([...events], true, [], reply), true))
    const explaining = [...transcript.render(80)]
    expect(transcript.animationLine).toBeUndefined()
    now += 300
    expect(transcript.render(80)).toEqual(explaining)

    events.push(entry({ event: { type: 'assistant/message', seq: 8, time: 1_850, surfaceOp: 'append', data: {
      turn: 1, step: 2, stream: [], message: { content: reply.content },
    } } }))
    events.push(entry({ event: { type: 'tool/call', seq: 9, time: 1_900, data: {
      turn: 1, step: 2, callId: 'next-group', name: 'read', arguments: '{}',
    } } }))
    transcript.setProjection(model.project(state([...events], true), true))
    const nextGroup = [...transcript.render(80)]
    const nextTitleRow = transcript.animationLine!
    expect(nextTitleRow).toBeGreaterThan(titleRow)
    now += 400
    expect(transcript.render(80)[titleRow]).toBe(nextGroup[titleRow])
    expect(transcript.render(80)[nextTitleRow]).not.toBe(nextGroup[nextTitleRow])

    events.push(entry({ event: { type: 'turn/end', seq: 10, time: 2_000, data: {
      turn: 1, reason: { kind: 'interrupted' },
    } } }))
    transcript.setProjection(model.project(state([...events]), true))
    const stopped = [...transcript.render(80)]
    expect(transcript.animationLine).toBeUndefined()
    expect(stripTerminalSequences(stopped[titleRow]!)).toContain('Activity · 2 tools · 800ms · 1 failed · 1 interrupted')
    now += 500
    expect(transcript.render(80)).toEqual(stopped)

    // A new Turn without its own Activity must not relight the previous Turn's groups.
    transcript.setProjection(model.project(state([...events, entry({ event: {
      type: 'turn/start', seq: 11, time: 2_500, data: { turn: 2 },
    } })], true), true))
    expect(transcript.render(80)).toEqual(stopped)
    expect(transcript.animationLine).toBeUndefined()
  })

  it('requests animation frames only while a rendered Activity is active and releases them with its Session', async () => {
    const model = new TranscriptModel(true, 8)
    vi.useFakeTimers()
    const scope = new LifecycleScope('transcript-animation')
    const events = [entry({ event: { type: 'assistant/message', seq: 0, time: 900, surfaceOp: 'append', data: {
      turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: 'Earlier message.\n\n'.repeat(12) }] },
    } } }), entry({ event: { type: 'tool/call', seq: 1, time: 1_000, data: {
      turn: 1, step: 1, callId: 'read', name: 'read', arguments: '{}',
    } } })]
    let current = state(events, true)
    let publish!: (value: RuntimeSessionSnapshot) => void
    const invalidate = vi.fn()
    const theme = createTheme(true)
    try {
      const transcript = new TranscriptProcess({
        session: {
          get current() { return current },
          subscribe(listener) { publish = listener; return () => {} },
        },
        details: new AtomicSnapshotStore(false),
        files: { readText: async () => '' },
        theme, showReasoning: true, maxToolOutputLines: 8, thinkingMaxLines: 8, invalidate, scope,
      })
      const layout = new ComposerAnchoredLayout(
        new Text('header', 0, 0), transcript, new Text('status', 0, 0),
        new Text('editor', 0, 0), new Text('footer', 0, 0), () => 8,
      )
      expect(vi.getTimerCount()).toBe(0)
      layout.render(80)
      vi.advanceTimersByTime(16)
      layout.render(80)
      vi.advanceTimersByTime(16)
      expect(invalidate).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      layout.render(80)
      expect(vi.getTimerCount()).toBe(1)
      layout.scrollTranscript(-100)
      layout.render(80)
      expect(vi.getTimerCount()).toBe(0)
      layout.followTranscript()
      layout.render(80)
      expect(vi.getTimerCount()).toBe(1)
      layout.setActiveSurface({ kind: 'workspace', component: new Text('Trace', 0, 0) })
      layout.render(80)
      expect(vi.getTimerCount()).toBe(0)
      layout.setActiveSurface(undefined)
      current = state(events)
      publish(current)
      layout.render(80)
      expect(vi.getTimerCount()).toBe(0)
      current = state(events, true)
      publish(current)
      layout.render(80)
      await scope.dispose()
      expect(vi.getTimerCount()).toBe(0)

      const plain = new TranscriptComponent(model.project(current, false), createTheme(false))
      expect(plain.render(80).join('\n')).toContain('Activity · 1 tool')
      expect(plain.animationLine).toBeUndefined()
    } finally {
      await scope.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps durable user input visible when execution metadata is unavailable', () => {
    const model = new TranscriptModel(true, 8)
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
    const transcript = new TranscriptComponent(model.project({
      ...snapshot,
      execution: buildExecutionSnapshot({
        sessionId: 'session-test',
        epoch: 0,
        entries: [],
        sessionRunning: false,
      }),
    }, false), createTheme(false))

    expect(transcript.render(80).join('\n')).toContain('Do not hide this input')
  })

  it('keeps native image markers on the admitted user prompt', () => {
    const model = new TranscriptModel(true, 8)
    const theme = createTheme(true)
    const image = (attachmentId: string) => ({
      type: 'image' as const,
      attachment: { attachmentId, mediaType: 'image/png', bytes: 10, width: 2, height: 2 },
    })
    const transcript = new TranscriptComponent(model.project(state([entry({
      event: {
        type: 'user/message',
        seq: 0,
        time: 1_000,
        surfaceOp: 'append',
        data: {
          id: 'message-user',
          role: 'user',
          source: { kind: 'user' },
          content: [
            { type: 'text', text: 'Compare [Image #2]' },
            image('image-2'),
            { type: 'text', text: ' with [Image #1]' },
            image('image-1'),
            { type: 'text', text: ' please' },
          ],
        },
      },
    })]), false), theme)

    const output = transcript.render(100).join('\n')
    expect(stripTerminalSequences(output))
      .toContain('Compare [Image #2] with [Image #1] please')
    expect(output).toContain(theme.imageReference('[Image #2]'))
    expect(output).toContain(theme.imageReference('[Image #1]'))
  })

  it('renders the committed assistant message', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
      entry({
        event: {
          type: 'assistant/message',
          seq: 1,
          time: 2,
          surfaceOp: 'append',
          data: {
            stream: [],
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
    ]), false), createTheme(false))

    const output = transcript.render(80).join('\n')
    expect(output).toContain('final answer')
    expect(output).not.toContain('partial')
    expect(output).not.toContain('Assistant')
  })

  it('settles the Thought indicator while answer text is still streaming', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([], true, [], {
      turn: 1, step: 1, reasoningStartedAt: 1_000, reasoningEndedAt: 1_250,
      content: [{ type: 'reasoning', text: 'reasoning' }, { type: 'text', text: 'streaming answer' }],
    }), false), createTheme(false))

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› Activity · 1 thought · 250ms')
    expect(collapsed).not.toContain('Thinking…')
    expect(collapsed).toContain('streaming answer')

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    expect(stripTerminalSequences(transcript.render(80).join('\n'))).toContain('└─ › • Thought')
  })

  it('renders assistant Markdown without exposing code-fence syntax', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
      entry({
        event: {
          type: 'assistant/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            stream: [],
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
    ]), false), createTheme(false))

    const output = transcript.render(80).join('\n')
    expect(output).toContain('Result')
    expect(output).toContain('this path')
    expect(output).toContain('/workspace/src')
    expect(output).not.toContain('# Result')
    expect(output).not.toContain('**')
    expect(output).not.toContain('```')
  })

  it('reuses the rendered document until transcript inputs or width change', () => {
    const model = new TranscriptModel(true, 8)
    const events = [entry({
      event: {
        type: 'assistant/message',
        seq: 0,
        time: 1,
        surfaceOp: 'append',
        data: {
          stream: [],
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
    const transcript = new TranscriptComponent(model.project(snapshot, false), createTheme(false))

    const first = transcript.render(80)
    expect(transcript.render(80)).toBe(first)

    transcript.setProjection(model.project({ ...snapshot, projections: { ...snapshot.projections } }, false))
    expect(transcript.render(80)).toBe(first)
    expect(transcript.render(72)).not.toBe(first)

    transcript.setProjection(model.project(state([...events, entry({
      event: {
        type: 'turn/end',
        seq: 1,
        time: 2,
        data: { reason: { kind: 'max-tokens' } },
      },
    })]), false))
    expect(transcript.render(80)).not.toBe(first)
  })

  it('renders deep Markdown headings without exposing their source markers', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
      entry({
        event: {
          type: 'assistant/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            stream: [],
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
    ]), false), createTheme(true))

    const output = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(output).toContain('Production CORS')
    expect(output).toContain('Error middleware')
    expect(output).not.toContain('###')
    expect(output.startsWith(' Production CORS')).toBe(true)
  })

  it('collapses activity by default and scrolls expanded thinking within its bounded viewport', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
      entry({
        event: {
          type: 'assistant/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            stream: [],
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
    ]), false), createTheme(true), 3)

    const collapsed = transcript.render(80).join('\n')
    expect(stripTerminalSequences(collapsed)).toContain('› Activity · 1 thought')
    expect(collapsed).not.toContain('thought 1')
    expect(collapsed).toContain('final answer')

    expect(transcript.handlePointer(0, 'move', false)).toBe(true)
    const hovered = transcript.render(80)
    expect(hovered.join('\n')).toContain('\u001b[1m\u001b[36m› Activity · 1 thought\u001b[39m\u001b[22m')
    expect(transcript.handlePointer(0, 'move', false)).toBe(false)
    expect(transcript.render(80)).toBe(hovered)
    expect(transcript.handlePointer(2, 'move', false)).toBe(true)

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const activity = transcript.render(80).join('\n')
    expect(stripTerminalSequences(activity)).toContain('└─ › • Thought')
    expect(activity).not.toContain('thought 1')

    expect(transcript.handlePointer(1, 'click', false)).toBe(true)
    const expanded = transcript.render(80).join('\n')
    expect(stripTerminalSequences(expanded)).toContain('⌄ • Thought')
    expect(expanded).toContain('thought 1')
    expect(expanded).toContain('\u001b[38;2;188;198;214m')
    expect(expanded).not.toContain('thought 8')
    expect(expanded.split('\n').filter(line => line.includes('│'))).toHaveLength(3)

    expect(transcript.handlePointer(2, 'wheel-down', false)).toBe(true)
    const scrolled = transcript.render(80).join('\n')
    expect(scrolled).toContain('thought 2')
    expect(scrolled).toContain('thought 4')
    expect(scrolled).not.toContain('thought 5')

    expect(transcript.handlePointer(1, 'click', false)).toBe(true)
    expect(transcript.render(80).join('\n')).not.toContain('thought 5')
  })

  it('preserves manual Activity disclosure as children are prepended and appended', () => {
    const model = new TranscriptModel(true, 8)
    const tool = entry({
      event: {
        type: 'tool/call',
        seq: 2,
        time: 1_200,
        data: { turn: 1, step: 1, callId: 'call-visible', name: 'read', arguments: '{}' },
      },
      view: { for: 'call', view: { card: 'generic', title: 'Read project' } },
    })
    const transcript = new TranscriptComponent(model.project(state([tool], true), false), createTheme(false))

    transcript.render(80)
    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    expect(stripTerminalSequences(transcript.render(80).join('\n'))).toContain('└─ › ◦ Read project')

    transcript.setProjection(model.project(state([
      entry({
        event: {
          type: 'assistant/message', surfaceOp: 'append',
          seq: 1, time: 1_100,
          data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'reasoning', text: 'earlier reasoning' }] } },
        },
      }),
      tool,
      entry({ event: { type: 'tool/call', seq: 3, time: 1_300, data: {
        turn: 1, step: 1, callId: 'test', name: 'bash', arguments: '{}',
      } } }),
    ], true), false))
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ Activity · 1 thought · 2 tools')
    expect(expanded).toContain('├─ › • Thought')
    expect(expanded).toContain('├─ › ◦ Read project')
    expect(expanded).toContain('└─ › ◦ Bash')
  })

  it('reports whether a disclosure block reaches the transcript end', () => {
    const model = new TranscriptModel(true, 8)
    const tool = entry({
      event: {
        type: 'tool/call',
        seq: 0,
        time: 1_000,
        data: { turn: 1, step: 1, callId: 'call-only', name: 'read', arguments: '{}' },
      },
      view: { for: 'call', view: { card: 'generic', title: 'Read project' } },
    })
    const transcript = new TranscriptComponent(model.project(state([tool], true), false), createTheme(false))
    transcript.render(80)

    expect(transcript.isTrailingBlock(0)).toBe(true)
    expect(transcript.isTrailingBlock(1)).toBe(false)
    // Disclosure clicks invalidate the render cache but keep the last block geometry.
    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    expect(transcript.isTrailingBlock(0)).toBe(true)

    transcript.setProjection(model.project(state([
      tool,
      entry({
        event: {
          type: 'user/message',
          seq: 1,
          time: 2_000,
          surfaceOp: 'append',
          data: {
            id: 'message-after',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'What next?' }],
          },
        },
      }),
    ], true), false))
    transcript.render(80)
    expect(transcript.isTrailingBlock(0)).toBe(false)
  })

  it('follows streaming thinking until the user scrolls upward', () => {
    const model = new TranscriptModel(true, 8)
    const live = (count: number) => state([], true, [], {
      turn: 1, step: 1, reasoningStartedAt: 1,
      content: [{ type: 'reasoning', text: Array.from({ length: count }, (_, index) => `- stream ${index + 1}\n`).join('') }],
    })
    const transcript = new TranscriptComponent(model.project(live(5), false), createTheme(false), 3)

    expect(transcript.render(80).join('\n')).toContain('› Activity · 1 thought')
    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    expect(stripTerminalSequences(transcript.render(80).join('\n'))).toContain('└─ › ◦ Thinking…')
    expect(transcript.handlePointer(1, 'click', false)).toBe(true)
    const following = transcript.render(80).join('\n')
    expect(following).toContain('stream 5')
    expect(following).not.toContain('stream 1')

    expect(transcript.handlePointer(2, 'wheel-up', false)).toBe(true)
    transcript.setProjection(model.project(live(6), false))
    const paused = transcript.render(80).join('\n')
    expect(paused).toContain('stream 2')
    expect(paused).not.toContain('stream 6')
  })

  it('settles unfinished activity when the turn reaches its output limit', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
      entry({
        event: {
          type: 'assistant/message', surfaceOp: 'append',
          seq: 0, time: 1_250,
          data: { turn: 1, step: 1, interrupted: true, stream: [{ type: 'reasoning-chunks', time0: 1_000, index: 0, dt: [], texts: ['unfinished reasoning'] }], message: { content: [{ type: 'reasoning', text: 'unfinished reasoning' }] } },
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
    ]), false), createTheme(false))

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› Activity · 1 thought · 1 tool · 250ms · 2 interrupted')
    expect(collapsed).toContain('The response reached the model output limit.')

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('├─ › ! Thought interrupted')
    expect(expanded).toContain('└─ › ! Search project')
  })

  it('keeps interrupted thinking collapsed while the terminal error remains visible', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
      entry({
        event: {
          type: 'assistant/message', surfaceOp: 'append',
          seq: 0, time: 2_300,
          data: { turn: 1, step: 1, interrupted: true, stream: [{ type: 'reasoning-chunks', time0: 2_000, index: 0, dt: [], texts: ['diagnostic reasoning'] }], message: { content: [{ type: 'reasoning', text: 'diagnostic reasoning' }] } },
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
    ]), false), createTheme(false))

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› Activity · 1 thought · 300ms · 1 interrupted')
    expect(collapsed).not.toContain('diagnostic reasoning')
    expect(collapsed).toContain('model disconnected')

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const activityExpanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(activityExpanded).toContain('⌄ Activity · 1 thought · 300ms · 1 interrupted')
    expect(activityExpanded).toContain('└─ › ! Thought interrupted')
    expect(activityExpanded).not.toContain('diagnostic reasoning')

    expect(transcript.handlePointer(1, 'click', false)).toBe(true)
    const thoughtExpanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(thoughtExpanded).toContain('└─ ⌄ ! Thought interrupted')
    expect(thoughtExpanded).toContain('diagnostic reasoning')
  })

  it('applies the global details toggle through the process and clears manual overrides', async () => {
    const snapshot = state([
      entry({
        event: {
          type: 'assistant/message',
          seq: 0,
          time: 1,
          surfaceOp: 'append',
          data: {
            stream: [],
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
    ])
    const scope = new LifecycleScope('transcript-details')
    const details = new AtomicSnapshotStore(false)
    const transcript = new TranscriptProcess({
      session: { current: snapshot, subscribe: () => () => {} },
      details,
      files: { readText: async () => '' }, theme: createTheme(false),
      showReasoning: true, maxToolOutputLines: 8, thinkingMaxLines: 8,
      invalidate: () => {}, scope,
    })
    try {
      expect(transcript.render(80).join('\n')).not.toContain('reasoning details')
      transcript.handlePointer(0, 'click')
      transcript.render(80)
      transcript.handlePointer(0, 'click')
      details.replace(true)
      const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
      expect(expanded).toContain('⌄ • Thought')
      expect(expanded).toContain('reasoning details')
      expect(expanded).toContain('⌄ • Read src/app.ts')
      expect(expanded).toContain('tool details')

      details.replace(false)
      const collapsed = transcript.render(80).join('\n')
      expect(collapsed).not.toContain('reasoning details')
      expect(collapsed).not.toContain('tool details')
    } finally { await scope.dispose() }
  })

  it('renders the complete user prompt as a full-width block without adding a You label', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), false), createTheme(true))

    const rendered = transcript.render(80)
    const output = rendered.join('\n')
    expect(rendered).toHaveLength(3)
    expect(rendered.every(line => line.includes('\u001b[48;2;36;42;58m'))).toBe(true)
    expect(rendered.every(line => visibleWidth(line) === 80)).toBe(true)
    expect(rendered.every(line => line.startsWith('\u001b[48;2;36;42;58m'))).toBe(true)
    expect(output).toContain('\u001b[97m› \u001b[39m')
    expect(output).toContain('\u001b[97mexplain this code\u001b[39m')
    expect(output).not.toContain('You')
  })

  it('renders a local prompt block without transport phases', () => {
    const model = new TranscriptModel(true, 8)
    const pending = state([], false, [{
      key: 1,
      text: 'render before the network round trip',
      mode: 'queue',
      intent: 'working',
    }])
    const transcript = new TranscriptComponent(model.project(pending, false), createTheme(true))

    const output = transcript.render(80).join('\n')
    expect(output).toContain('\u001b[97m› \u001b[39m')
    expect(output).toContain('\u001b[97mrender before the network round trip\u001b[39m')
    expect(output).not.toContain('Accepted')
    expect(output).not.toContain('Sending')
    expect(output).not.toContain('You')
  })

  it('hands Vision preparation to durable tool evidence without duplicating the prompt or Activity', () => {
    const model = new TranscriptModel(true, 8)
    const pending = state([], false, [{
      key: 1, text: 'analyze [Image #1] now', mode: 'queue', intent: 'working',
      activity: { kind: 'vision', analysisId: 'analysis-1', imageCount: 1, startedAt: 1_000 },
    }])
    const transcript = new TranscriptComponent(model.project(pending, false), createTheme(true))
    const initial = transcript.render(80).map(stripTerminalSequences).join('\n')
    expect(initial).toMatch(/analyze \[Image #1\] now[\s\S]*Activity · 1 tool/u)
    expect(transcript.animationLine).toBeDefined()

    const events = [
      entry({ event: { type: 'turn/start', seq: 0, time: 1_500, data: { turn: 1 } } }),
      entry({ event: { type: 'user/message', seq: 1, time: 1_500, surfaceOp: 'append', data: {
        id: 'message-user', role: 'user', source: { kind: 'user', rpcId: 'rpc-image' },
        content: [
          { type: 'text', text: 'analyze [Image #1]' },
          { type: 'text', text: ' now' },
          visionEvidenceBlock({
            analysisId: 'analysis-1', provider: 'bailian', model: 'qwen3.7-plus',
            observation: 'An error dialog is visible.',
            attachments: [{ attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: 10, width: 2, height: 2 }],
            references: ['[Image #1]'], durationMs: 500, finishReason: 'stop', truncated: false,
          }),
        ],
      } } }),
      entry({ event: { type: 'step/start', seq: 2, time: 1_600, data: { turn: 1, step: 1 } } }),
      entry({ event: { type: 'tool/call', seq: 4, time: 1_700, data: {
        turn: 1, step: 1, callId: 'read', name: 'read', arguments: '{}',
      } } }),
    ]
    // Durable evidence replaces the pending source without duplicating the Vision tool.
    transcript.setProjection(model.project(state(events, true), false))
    const tools = transcript.render(80).map(stripTerminalSequences).join('\n')
    expect(tools.match(/analyze \[Image #1\] now/g)).toHaveLength(1)
    expect(tools.match(/Activity/g)).toHaveLength(1)
    expect(tools).toContain('Activity · 2 tools')
    expect(transcript.animationLine).toBeDefined()
    transcript.setProjection(model.project(state(events, true), true))
    const details = transcript.render(80).map(stripTerminalSequences).join('\n')
    expect(details).toContain('Vision · 1 image · qwen3.7-plus')
    expect(details).toContain('An error dialog is visible.')
    expect(details).toContain('bailian/qwen3.7-plus')
  })

  it('shows the complete merged user body before every same-message Vision item', () => {
    const content = [1, 2].flatMap(index => [
      ...index === 1 ? [] : [{ type: 'text' as const, text: '\n\n' }],
      { type: 'text' as const, text: `inspect [Image #${String(index)}]` },
      visionEvidenceBlock({
        analysisId: `merged-${String(index)}`, provider: 'bailian', model: 'qwen',
        observation: `Observation ${String(index)}`,
        attachments: [{ attachmentId: AttachmentId(`image-${String(index)}`), mediaType: 'image/png', bytes: 10, width: 2, height: 2 }],
        references: [`[Image #${String(index)}]`], durationMs: 500, finishReason: 'stop', truncated: false,
      }),
    ])
    const model = new TranscriptModel(true, 8)
    const projection = model.project(state([entry({ event: {
      type: 'user/message', seq: 0, time: 1_500, surfaceOp: 'append',
      data: { id: 'merged', role: 'user', source: { kind: 'user' }, content },
    } })]), true)

    expect(projection.items).toMatchObject([
      { kind: 'prompt', body: 'inspect [Image #1]\n\ninspect [Image #2]' },
      { kind: 'activity', items: [
        { kind: 'tool', key: 'vision:merged-1', result: 'Observation 1' },
        { kind: 'tool', key: 'vision:merged-2', result: 'Observation 2' },
      ] },
    ])
    const output = new TranscriptComponent(projection, createTheme(true)).render(80).map(stripTerminalSequences).join('\n')
    expect(output).toMatch(/inspect \[Image #1\][\s\S]*inspect \[Image #2\][\s\S]*Observation 1[\s\S]*Observation 2/u)
  })

  it('hands a local prompt to a visible queue row without hiding context placement', () => {
    const model = new TranscriptModel(true, 8)
    const base = state([])
    const queued = {
      ...base,
      pendingSubmissions: [{
      key: 1,
      text: 'queued once',
      mode: 'queue',
      intent: 'working',
      requestId: 'rpc-queued' as never,
      }],
      queue: [{
        id: 'message-queued' as never,
        placement: 'queued',
        rpcId: 'rpc-queued' as never,
        message: {
          id: 'message-queued' as never,
          content: [{ type: 'text', text: 'queued once' }],
        },
      }],
    } satisfies RuntimeSessionSnapshot

    const visible = new TranscriptComponent(model.project(queued, false), createTheme(false)).render(80).join('\n')
    expect(visible.match(/queued once/g)).toHaveLength(1)
    expect(visible).toContain('Queued')

    const contextual = {
      ...queued,
      queue: [{ ...queued.queue[0]!, placement: 'context' as const }],
    }
    const context = new TranscriptComponent(model.project(contextual, false), createTheme(false)).render(80).join('\n')
    expect(context).toContain('queued once')
    expect(context).not.toContain('Accepted')
  })

  it('uses the tool-owned operation summary and expands bounded result output', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), true), createTheme(false))


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
    const model = new TranscriptModel(true, 8)
    const script = callView.title
    const transcript = new TranscriptComponent(model.project(state([
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
    ], true), false), createTheme(false))

    const collapsed = stripTerminalSequences(transcript.render(120).join('\n'))
    expect(collapsed).toContain('› Activity · 1 tool')
    expect(collapsed).not.toContain('Inspect dispatch tests')
    expect(collapsed).not.toContain('python3')

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const activity = stripTerminalSequences(transcript.render(120).join('\n'))
    expect(activity).toContain('⌄ Activity · 1 tool')
    expect(activity).toContain(`└─ › ◦ ${operation}`)
    expect(activity).not.toContain('python3')

    expect(transcript.handlePointer(1, 'click', false)).toBe(true)
    const details = stripTerminalSequences(transcript.render(120).join('\n'))
    expect(details).toContain('Arguments')
    expect(details).toContain("python3 - <<'PYEOF'")
    expect(details).toContain('import re')
  })

  it('reveals a grouped tool operation before its arguments and result', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), false), createTheme(true))

    const collapsedOutput = transcript.render(80).join('\n')
    const collapsed = stripTerminalSequences(collapsedOutput)
    expect(collapsed).toContain('› Activity · 1 tool · 1ms')
    expect(collapsed).not.toContain('render details')
    expect(collapsed).not.toContain('3 matches')

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const activityOutput = transcript.render(80).join('\n')
    const activity = stripTerminalSequences(activityOutput)
    expect(activity).toContain('└─ › • Search project')
    expect(activityOutput).toContain('\u001b[1m\u001b[32m•\u001b[39m\u001b[22m')
    expect(activityOutput).toContain('\u001b[38;2;125;211;252mSearch project\u001b[39m')

    expect(transcript.handlePointer(1, 'click', false)).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ • Search project')
    expect(expanded).toContain('Arguments')
    expect(expanded).toContain('render details')
    expect(expanded).toContain('Result')
    expect(expanded).toContain('3 matches')

    expect(transcript.handlePointer(1, 'click', false)).toBe(true)
    expect(transcript.render(80).join('\n')).not.toContain('3 matches')
    expect(transcript.render(32).every(line => visibleWidth(line) === 32)).toBe(true)
  })

  it('keeps failed activity and tool details collapsed until they are opened', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), false), createTheme(false))

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› Activity · 1 tool · 250ms · 1 failed')
    expect(collapsed).not.toContain('Run tests')
    expect(collapsed).not.toContain('pnpm test')
    expect(collapsed).not.toContain('1 test failed')
    expect(collapsed).not.toContain('[exit 1]')

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const activity = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(activity).toContain('⌄ Activity · 1 tool · 250ms · 1 failed')
    expect(activity).toContain('└─ › × Bash · Run tests')
    expect(activity).not.toContain('pnpm test')
    expect(activity).not.toContain('1 test failed')

    expect(transcript.handlePointer(1, 'click', false)).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('└─ ⌄ × Bash · Run tests')
    expect(expanded).toContain('pnpm test')
    expect(expanded).toContain('1 test failed')
    expect(expanded).toContain('[exit 1]')
  })

  it('shows complete applied file diffs inline and leaves wheel scrolling to the conversation', () => {
    const model = new TranscriptModel(true, 3)
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), false), createTheme(true))
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
    expect(transcript.handlePointer(1, 'wheel-down', false)).toBe(false)
    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› • Update(src/app.ts)')
    expect(collapsed).not.toContain('const mode')
  })

  it('keeps a large file edit responsive while preserving full on-demand evidence', () => {
    const model = new TranscriptModel(true, 8)
    const newText = Array.from({ length: 201 }, (_, index) => `export const value${index} = ${index}`).join('\n')
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), false), createTheme(true))

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› • Write(src/generated.ts)')
    expect(collapsed).toContain('└ Added 201 lines')
    expect(collapsed).not.toContain('value200')

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ • Write(src/generated.ts)')
    expect(expanded).toContain('201 + export const value200 = 200')
  })

  it('keeps failed file evidence top-level but collapsed until it is opened', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), false), createTheme(false))

    const collapsed = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(collapsed).toContain('› × Update(src/app.ts)')
    expect(collapsed).not.toContain('partially applied')

    expect(transcript.handlePointer(0, 'click', false)).toBe(true)
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'))
    expect(expanded).toContain('⌄ × Update(src/app.ts)')
    expect(expanded).toContain('partially applied')
  })

  it('wraps long changed lines without hiding their tail', () => {
    const model = new TranscriptModel(true, 8)
    const longLine = 'A long changed line keeps wrapping until the unique VISIBLE_TAIL remains readable.'
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), false), createTheme(true))

    const output = transcript.render(32)
    const plain = stripTerminalSequences(output.join('\n'))
    const addedRows = output.filter(line => line.includes('\u001b[48;2;12;48;28m'))
    expect(plain).toContain('VISIBLE_TAIL')
    expect(addedRows.length).toBeGreaterThan(1)
    expect(output.every(line => visibleWidth(line) === 32)).toBe(true)
  })

  it('renders one durable command execution row with its settled result', () => {
    const model = new TranscriptModel(true, 8)
    const transcript = new TranscriptComponent(model.project(state([
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
    ]), false), createTheme(false))

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
