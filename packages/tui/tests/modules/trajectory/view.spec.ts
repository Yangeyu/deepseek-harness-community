import { Text, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/manager.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import { ComposerAnchoredLayout } from '../../../src/presentation/shell/layout/composer-layout.ts'
import { TrajectoryView } from '../../../src/modules/trajectory/view.ts'
import { state, timedTraceEvents, toolEvents } from './fixtures.ts'

describe('TrajectoryView', () => {
  it('keeps its semantic record projection stable across inert stream deltas', () => {
    const initial = state(toolEvents(true), { runState: 'running' })
    const view = new TrajectoryView(
      initial,
      () => 8,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )
    const internals = view as unknown as { records: readonly unknown[] }
    const records = internals.records
    const chunk = {
      event: {
        type: 'assistant/chunk',
        seq: 6,
        time: 1_800,
        data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'live' } },
      },
    } as RuntimeSessionSnapshot['events'][number]

    view.setState({ ...initial, events: [...initial.events, chunk] })

    expect(internals.records).toBe(records)
  })

  it('supports Vim j/k navigation in the ledger and detail viewport', () => {
    const assistant = {
      event: {
        type: 'assistant/message',
        seq: 5,
        time: 1_700,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-vim',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'chat' },
            content: [{ type: 'text', text: 'Vim navigation response' }],
          },
        },
      },
    } as RuntimeSessionSnapshot['events'][number]
    const view = new TrajectoryView(
      state([...toolEvents(true), assistant]),
      () => 8,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    view.handleAction('surface.previous')
    view.handleAction('surface.confirm')
    expect(view.render(100).join('\n')).toContain('Trajectory · bash · echo NAVIGATION_OK')

    view.handleAction('surface.tab-next')
    const top = view.render(100)
    view.handleAction('surface.next')
    expect(view.render(100)).not.toEqual(top)
    view.handleAction('surface.previous')
    expect(view.render(100)).toEqual(top)

    view.handleAction('surface.back')
    view.handleAction('surface.next')
    view.handleAction('surface.confirm')
    expect(view.render(100).join('\n')).toContain('Trajectory · Assistant response')
  })

  it('scrolls the split detail panel with Shift+J/K while j/k keep selecting records', () => {
    const user = (seq: number, id: string, text: string): RuntimeSessionSnapshot['events'][number] => ({
      event: {
        type: 'user/message',
        seq,
        time: seq * 1_000,
        surfaceOp: 'append',
        data: {
          id,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text }],
        },
      },
    } as RuntimeSessionSnapshot['events'][number])
    const longText = Array.from({ length: 40 }, (_, index) => `detail line ${String(index + 1)}`).join('\n')
    const view = new TrajectoryView(
      state([user(0, 'message-a', 'First short input'), user(1, 'message-b', longText), user(2, 'message-c', 'Last short input')]),
      () => 24,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )
    const internals = view as unknown as { index: number; detailOffset: number; detailMaxOffset: number }

    view.render(120)
    expect(internals.index).toBe(2)

    view.handleAction('surface.previous')
    view.render(120)
    expect(internals.index).toBe(1)
    expect(internals.detailMaxOffset).toBeGreaterThan(0)
    expect(internals.detailOffset).toBe(0)

    view.handleAction('surface.detail-previous')
    view.render(120)
    expect(internals.index).toBe(1)
    expect(internals.detailOffset).toBe(0)

    view.handleAction('surface.detail-next')
    view.render(120)
    expect(internals.index).toBe(1)
    expect(internals.detailOffset).toBe(1)

    view.handleAction('surface.detail-previous')
    view.render(120)
    expect(internals.index).toBe(1)
    expect(internals.detailOffset).toBe(0)

    view.handleAction('surface.next')
    view.render(120)
    expect(internals.index).toBe(2)
    expect(internals.detailOffset).toBe(0)

    view.handleAction('surface.previous')
    view.render(120)
    expect(internals.index).toBe(1)
    view.handleAction('surface.confirm')
    view.handleAction('surface.detail-next')
    view.render(120)
    expect(internals.detailOffset).toBe(1)
    view.handleAction('surface.detail-previous')
    view.render(120)
    expect(internals.detailOffset).toBe(0)
  })

  it('navigates from the ledger through payload and result details, then back to chat', () => {
    const close = vi.fn()
    const view = new TrajectoryView(
      state(toolEvents(true)),
      () => 14,
      createTheme(false),
      async () => false,
      vi.fn(),
      close,
      vi.fn(),
    )

    expect(view.render(100).join('\n')).toContain('TOOL      bash · Completed')
    view.handleAction('surface.confirm')
    expect(view.render(100).join('\n')).toContain('[Summary]')
    expect(view.render(100).join('\n')).toContain('Event        tool/call → tool/result')
    expect(view.render(100).join('\n')).toContain('Tool         bash')
    expect(view.render(100).join('\n')).toContain('Operation    echo NAVIGATION_OK')

    view.handleAction('surface.tab-next')
    expect(view.render(100).join('\n')).toContain('echo NAVIGATION_OK')
    view.handleAction('surface.tab-next')
    expect(view.render(100).join('\n')).toContain('NAVIGATION_OK')

    view.handleAction('surface.back')
    expect(view.render(100).join('\n')).toContain('TOOL      bash · Completed')
    view.handleAction('surface.back')
    expect(close).toHaveBeenCalledOnce()
  })

  it('updates a pending tool record in place as its durable result arrives', () => {
    const view = new TrajectoryView(
      state(toolEvents(false), { runState: 'running' }),
      () => 12,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )
    expect(view.render(100).join('\n')).toContain('bash · Running')

    view.setState(state(toolEvents(true)))

    expect(view.render(100).join('\n')).toContain('bash · Completed')
  })

  it('keeps the focus band active after truncating a long event without share metrics', () => {
    const approval = {
      event: {
        type: 'approval/decided',
        seq: 5,
        time: 1_800,
        data: {
          id: '5ff5203a-bb2b-4e5d-96d2-24801be72c-long-approval-identifier',
          decision: 'approved',
        },
      },
    } as RuntimeSessionSnapshot['events'][number]
    const view = new TrajectoryView(
      state([...toolEvents(true), approval]),
      () => 10,
      createTheme(true),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    const eventRow = view.render(100).find(line => line.includes('approval/decided')) ?? ''
    view.handleAction('surface.previous')
    const toolRow = view.render(100).find(line => line.includes('TOOL')) ?? ''
    const focus = '\u001b[48;2;42;70;98m'

    expect(eventRow.startsWith(focus)).toBe(true)
    expect(toolRow.startsWith(focus)).toBe(true)
    expect(eventRow).toContain(`\u001b[0m${focus}…\u001b[0m${focus}`)
    expect(eventRow.endsWith('\u001b[49m')).toBe(true)
    expect(toolRow.endsWith('\u001b[49m')).toBe(true)
    expect(visibleWidth(eventRow)).toBe(100)
    expect(visibleWidth(toolRow)).toBe(100)
  })

  it('keeps duration visible while omitting verbose tool operations from a narrow ledger row', () => {
    const entries = toolEvents(true)
    const call = entries[0]
    if (call?.event.type === 'tool/call') {
      call.view = {
        for: 'call',
        view: { card: 'terminal', title: 'a very long tool title that cannot fit in a narrow terminal row' },
      }
    }
    const view = new TrajectoryView(
      state(entries),
      () => 10,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    const output = view.render(52).join('\n')
    const toolRow = output.split('\n').find(line => line.includes('TOOL')) ?? ''

    expect(output).toContain('300ms')
    expect(toolRow).toContain('bash · Completed')
    expect(toolRow).not.toContain('a very long tool title')
  })

  it('renders a responsive split trace explorer with bottleneck and complete Summary details', () => {
    const view = new TrajectoryView(
      state(timedTraceEvents()),
      () => 20,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    view.handleAction('surface.previous')
    const overview = view.render(140).join('\n')

    expect(overview).toContain('Bottleneck · bash · slow tool · 700 ms')
    expect(overview).toContain('EXECUTION')
    expect(overview).toContain('DETAIL · bash · slow tool')
    expect(overview).toContain('Duration     700 ms')
    expect(overview).toContain('Bottleneck   Slowest timed block in Step 1')
    expect(overview).toContain('Tool         bash')
    expect(overview).toContain('Operation    slow tool')
    expect(overview).toContain('▲')

    view.handleAction('surface.confirm')
    view.handleAction('surface.tab-next')
    const input = view.render(140).join('\n')
    expect(input).toContain('[Input]')
    expect(input).toContain('Detail focus')
    expect(input).toContain('slow tool')
  })

  it('keeps the responsive detail pane when rendered through a full-width application surface', () => {
    const view = new TrajectoryView(
      state(timedTraceEvents()),
      () => 20,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )
    const layout = new ComposerAnchoredLayout(
      new Text('', 0, 0),
      new Text('', 0, 0),
      new Text('', 0, 0),
      new Text('', 0, 0),
      new Text('', 0, 0),
      () => 20,
    )
    layout.setActiveSurface({ kind: 'workspace', component: view })

    const output = layout.render(140).join('\n')

    expect(output).toContain('DETAIL · bash · fast tool')
    expect(output).toContain('Tool         bash')
  })

  it('collapses and expands semantic hierarchy nodes with h/l', () => {
    const view = new TrajectoryView(
      state(timedTraceEvents()),
      () => 14,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    view.handleAction('surface.first')
    view.handleAction('surface.collapse')
    const collapsed = view.render(100).join('\n')
    expect(collapsed).toContain('1/4 visible')
    expect(collapsed).toContain('▸ • TURN')
    expect(collapsed).not.toContain('bash · Completed')

    view.handleAction('surface.expand')
    const expanded = view.render(100).join('\n')
    expect(expanded).toContain('4 records')
    expect(expanded).toContain('▾ • TURN')
    expect(expanded.match(/bash · Completed/gu)).toHaveLength(2)
  })

  it('wraps the complete Summary text instead of reusing the truncated ledger preview', () => {
    const detail = `${'Complete diagnostic sentence. '.repeat(8)}VISIBLE_TAIL`
    const entries = [{
      event: { type: 'step/start', seq: 0, time: 1_000, data: { turn: 1, step: 1 } },
    }, {
      event: {
        type: 'assistant/message',
        seq: 1,
        time: 2_500,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-summary',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'chat' },
            content: [{ type: 'text', text: detail }],
          },
        },
      },
    }] as RuntimeSessionSnapshot['events']
    const view = new TrajectoryView(
      state(entries),
      () => 24,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )

    view.handleAction('surface.confirm')
    const output = view.render(70).join('\n')

    expect(output).toContain('Duration     Not measured')
    expect(output).toContain('VISIBLE_TAIL')
  })

  it('pins an opened detail record while newer live events arrive', () => {
    const view = new TrajectoryView(
      state(toolEvents(false), { runState: 'running' }),
      () => 12,
      createTheme(false),
      async () => false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    )
    view.handleAction('surface.confirm')
    const assistant = {
      event: {
        type: 'assistant/message',
        seq: 5,
        time: 1_700,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-live',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'chat' },
            content: [{ type: 'text', text: 'Newer response' }],
          },
        },
      },
    } as RuntimeSessionSnapshot['events'][number]

    view.setState(state([...toolEvents(true), assistant]))

    expect(view.render(100).join('\n')).toContain('Trajectory · bash · echo NAVIGATION_OK')
    expect(view.render(100).join('\n')).not.toContain('Trajectory · Assistant response')
  })

  it('keeps Ctrl+C available for interrupting a live turn', () => {
    const interrupt = vi.fn()
    const close = vi.fn()
    const view = new TrajectoryView(
      state(toolEvents(false), { runState: 'running' }),
      () => 12,
      createTheme(false),
      async () => false,
      interrupt,
      close,
      vi.fn(),
    )

    view.handleAction('surface.interrupt-or-cancel')

    expect(interrupt).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
  })

  it('loads an earlier history page from the top of the current ledger', async () => {
    const loadEarlier = vi.fn(async () => true)
    const changed = vi.fn()
    const view = new TrajectoryView(
      state(toolEvents(true), { historyHasMore: true }),
      () => 12,
      createTheme(false),
      loadEarlier,
      vi.fn(),
      vi.fn(),
      changed,
    )

    view.handleAction('surface.previous')
    await vi.waitFor(() => { expect(loadEarlier).toHaveBeenCalledOnce() })

    expect(changed).toHaveBeenCalled()
  })
})
