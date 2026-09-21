import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { InboxWireState } from '@deepseek-ai/dsh-agent'
import { Text, stripTerminalSequences } from '@earendil-works/pi-tui'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { SessionRuntime } from '../../../src/runtime/session/runtime.ts'
import type { HistoryEntry, SessionId } from '../../../src/runtime/session/contracts.ts'
import { TranscriptModel } from '../../../src/modules/transcript/model.ts'
import { TranscriptComponent } from '../../../src/modules/transcript/view.ts'
import { PendingInputPreview } from '../../../src/modules/transcript/pending-input.ts'
import { ComposerAnchoredLayout } from '../../../src/presentation/shell/layout/composer-layout.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'

const emptyInbox = { 'next-turn': [], 'next-step': [] }
const runtimes: SessionRuntime[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())) })

function entry(seq: number, type: string, data: unknown, append = false): HistoryEntry {
  return { event: { seq, time: seq, type, data, ...append ? { surfaceOp: 'append' } : {} } } as HistoryEntry
}

function fixture(events: readonly HistoryEntry[] = [], nextStep: readonly UserMessage[] = []) {
  const runtime = new SessionRuntime(new LifecycleScope('handoff'), 'session-test' as SessionId, 1, '/workspace', {
    events: 'online', control: 'online',
  })
  runtimes.push(runtime)
  let seq = events.at(-1)?.event.seq ?? 0
  runtime.hydrate({
    events, hasMore: false,
    projections: { asOfSeq: seq, values: { inbox: { 'next-turn': [], 'next-step': nextStep as unknown as InboxWireState['next-step'] } } },
  }, seq)
  return {
    runtime,
    emit(type: string, data: unknown, append = false) {
      const event = entry(++seq, type, data, append)
      expect(runtime.appendEvent(event)).toBe('appended')
      return event
    },
  }
}

function inboxSplice(inserted: readonly UserMessage[], removedCount = 0, outcome?: 'canceled') {
  return { target: 'next-step', start: 0, inserted, removedCount, ...outcome === undefined ? {} : { outcome } }
}

function visiblePrompts(runtime: SessionRuntime): string[] {
  const projection = new TranscriptModel(false, 8).project(runtime.current, false)
  return [
    ...projection.items.flatMap(item => item.kind === 'prompt' ? [item.body] : []),
    ...projection.pendingInputs.map(item => item.text),
  ]
}

describe('prompt handoff', () => {
  it.each([
    ['steer', 18], ['steer', 24], ['queue', 18], ['queue', 24],
  ] as const)('keeps %s in its display region until its single conversation handoff (%i rows)', (mode, rows) => {
    const oldUser = createUserMessage({ content: [{ type: 'text', text: 'PREVIOUS USER' }], source: { kind: 'user' } })
    const { runtime, emit } = fixture([
      entry(1, 'user/message', oldUser, true),
      entry(2, 'assistant/message', { turn: 1, step: 1, stream: [], message: {
        role: 'assistant', content: [{ type: 'text', text: 'PREVIOUS ANSWER' }],
      } }, true),
    ])
    const text = 'NEW MESSAGE LINE ONE\nNEW MESSAGE LINE TWO'
    const pending = runtime.startSubmission(text, mode)!
    const target = mode === 'steer' ? 'next-step' : 'next-turn'
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: pending.requestId } })
    const model = new TranscriptModel(false, 8)
    const transcript = new TranscriptComponent(model.project(runtime.current, false), createTheme(false))
    const preview = new PendingInputPreview(createTheme(false))
    const content = Object.assign(transcript, {
      renderPendingInputs: (width: number, budget: number) => preview.render(width, budget),
    })
    const layout = new ComposerAnchoredLayout(
      new Text('APP TITLE\n/workspace · session', 0, 0), content,
      new Text('STATUS', 0, 0), new Text('\nEDITOR\n', 0, 0), new Text('MODEL\nTOKEN STATS', 0, 0), () => rows,
    )
    const frames: { oldRow: number; newRow: number; lines: number }[] = []
    const capture = (): void => {
      const projection = model.project(runtime.current, false)
      const inHistory = projection.items.filter(item => item.kind === 'prompt' && item.key === `prompt:${pending.requestId}`).length
      const inPreview = projection.pendingInputs.filter(item => item.key === `prompt:${pending.requestId}`).length
      expect(inHistory + inPreview).toBe(1)
      transcript.setProjection(projection)
      preview.setItems(projection.pendingInputs)
      const frame = layout.render(80).map(stripTerminalSequences)
      expect(frame.filter(line => line.includes('NEW MESSAGE LINE ONE'))).toHaveLength(1)
      frames.push({ oldRow: frame.findIndex(line => line.includes('PREVIOUS USER')),
        newRow: frame.findIndex(line => line.includes('NEW MESSAGE LINE ONE')), lines: frame.length })
    }
    capture()
    runtime.subscribe(capture)
    emit('turn/start', { turn: 2 })
    emit('agent/inbox/spliced', { ...inboxSplice([message]), target })
    expect(runtime.current.pendingSubmissions).toEqual([])
    // A control projection ahead of follow cannot remove or duplicate its visible row.
    runtime.applyProjection('inbox', emptyInbox, 100)
    emit('agent/inbox/spliced', { ...inboxSplice([], 1), target })
    expect(runtime.current.queue).toEqual([])
    expect(runtime.current.pendingSubmissions[0]?.messageId).toBe(message.id)
    expect(frames.length).toBeGreaterThan(4)
    expect(frames.every(frame => frame.oldRow === frames[0]!.oldRow && frame.newRow === frames[0]!.newRow && frame.lines === rows)).toBe(true)
    emit('user/message', message, true)
    expect(runtime.current.pendingSubmissions).toEqual([])
    const accepted = model.project(runtime.current, false)
    expect(accepted.pendingInputs).toEqual([])
    expect(accepted.items.filter(item => item.kind === 'prompt' && item.body === text)).toHaveLength(1)
    expect(frames.at(-1)?.lines).toBe(rows)
    if (mode === 'queue') expect(frames.at(-1)).toEqual(frames[0])
  })

  it('keeps consumed input first in the preview until each prompt moves into conversation', () => {
    const { runtime, emit } = fixture()
    runtime.setRunState('running')
    const messages = ['FIRST QUEUED', 'SECOND QUEUED'].map(text => createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }))
    emit('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: messages })
    runtime.startSubmission('NEW LOCAL', 'queue')
    const model = new TranscriptModel(false, 8)
    const preview = new PendingInputPreview(createTheme(false))
    const renderPreview = (): string[] => {
      preview.setItems(model.project(runtime.current, false).pendingInputs)
      return preview.render(80).map(stripTerminalSequences)
    }
    for (const [index, message] of messages.entries()) {
      const before = renderPreview()
      emit('turn/start', { turn: index + 1 })
      emit('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
      expect(renderPreview()).toEqual(before)
      emit('user/message', message, true)
      emit('turn/end', { turn: index + 1, reason: { kind: 'aborted', reason: 'test' } })
      expect(visiblePrompts(runtime)).toEqual(['FIRST QUEUED', 'SECOND QUEUED', 'NEW LOCAL'])
    }
    expect(model.project(runtime.current, false).pendingInputs.map(item => item.text)).toEqual(['NEW LOCAL'])
  })

  it('retires canceled steering and hands the ESC replacement over without resurrecting old echoes', () => {
    const { runtime, emit } = fixture()
    emit('turn/start', { turn: 1 })
    const first = runtime.startSubmission('first', 'steer')!
    const second = runtime.startSubmission('second', 'steer')!
    const messages = [first, second].map(prompt => createUserMessage({
      content: [{ type: 'text', text: prompt.text }], source: { kind: 'user', rpcId: prompt.requestId },
    }))
    emit('agent/inbox/spliced', inboxSplice(messages))
    emit('agent/inbox/spliced', inboxSplice([], 2, 'canceled'))
    emit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'ESC' } })
    expect(visiblePrompts(runtime)).toEqual([])

    // The Host's replacement has no local startSubmission and may have no RPC identity.
    const merged = createUserMessage({ content: [{ type: 'text', text: 'first\n\nsecond' }], source: { kind: 'user' } })
    emit('agent/inbox/spliced', inboxSplice([merged]))
    emit('turn/start', { turn: 2 })
    emit('agent/inbox/spliced', inboxSplice([], 1))
    expect(visiblePrompts(runtime)).toEqual(['first\n\nsecond'])
    emit('user/message', merged, true)
    expect(visiblePrompts(runtime)).toEqual(['first\n\nsecond'])
    expect(runtime.current.pendingSubmissions).toEqual([])
  })

  it('seeds inbox once at the snapshot cut and keeps context positions while older history is loaded', () => {
    const context = createUserMessage({ content: [{ type: 'text', text: 'hidden context' }],
      source: { kind: 'plugin', plugin: 'test', form: 'instructions', summary: 'context' } })
    const message = createUserMessage({ content: [{ type: 'text', text: 'visible' }], source: { kind: 'user' } })
    const admission = entry(3, 'agent/inbox/spliced', inboxSplice([context, message]))
    const { runtime, emit } = fixture([admission], [context, message])
    expect(runtime.current.queue).toHaveLength(2)
    expect(runtime.appendEvent(admission)).toBe('duplicate')
    runtime.prependHistory({ events: [entry(1, 'turn/start', { turn: 1 })], hasMore: false })
    expect(runtime.current.queue).toHaveLength(2)
    emit('agent/inbox/spliced', { target: 'next-step', start: 1, removedCount: 1, inserted: [] })
    expect(runtime.current.queue).toHaveLength(1)
    expect(visiblePrompts(runtime)).toEqual(['visible'])
    const next = runtime.startSubmission('still preparing', 'queue')!
    emit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'before user admission' } })
    expect(runtime.current.pendingSubmissions).toEqual([next])
  })

  it.each([1, undefined])('uses only later turn boundaries to retire handoffs across paged reconnects (known turn: %s)', (turn) => {
    const { runtime, emit } = fixture(turn === undefined ? [] : [entry(1, 'turn/start', { turn })])
    const message = createUserMessage({ content: [{ type: 'text', text: 'claimed' }], source: { kind: 'user' } })
    emit('agent/inbox/spliced', inboxSplice([message]))
    emit('agent/inbox/spliced', inboxSplice([], 1))
    const pending = runtime.startSubmission('new preparation', 'queue')!
    const cursor = runtime.historyCursor!
    runtime.hydrate({ events: [entry(0, 'turn/end', { turn: 0, reason: { kind: 'aborted', reason: 'old turn' } }), ...runtime.current.events],
      hasMore: false, projections: { asOfSeq: cursor, values: { inbox: emptyInbox } } }, cursor)
    expect(visiblePrompts(runtime)).toEqual(['new preparation', 'claimed'])
    runtime.hydrate({ events: [entry(20, 'turn/start', { turn: 3 })], hasMore: true,
      projections: { asOfSeq: 20, values: { inbox: emptyInbox } } }, 20)
    expect(runtime.current.pendingSubmissions).toEqual([pending])
  })

  it('retains an existing handoff across a same-epoch snapshot and does not settle on a gap event', () => {
    const { runtime, emit } = fixture()
    emit('turn/start', { turn: 1 })
    const message = createUserMessage({ content: [{ type: 'text', text: 'survives reconnect' }], source: { kind: 'user' } })
    emit('agent/inbox/spliced', inboxSplice([message]))
    emit('agent/inbox/spliced', inboxSplice([], 1))
    const gap = entry(5, 'user/message', message, true)
    expect(runtime.appendEvent(gap)).toBe('gap')
    expect(visiblePrompts(runtime)).toEqual(['survives reconnect'])
    runtime.hydrate({ events: runtime.current.events, hasMore: false,
      projections: { asOfSeq: 3, values: { inbox: emptyInbox } } }, 3)
    expect(visiblePrompts(runtime)).toEqual(['survives reconnect'])
    emit('user/message', message, true)
    expect(visiblePrompts(runtime)).toEqual(['survives reconnect'])
    expect(runtime.current.pendingSubmissions).toEqual([])
  })
})
