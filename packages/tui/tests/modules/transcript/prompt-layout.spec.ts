import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, Text, visibleWidth } from '@earendil-works/pi-tui'
import { PendingInputPreview } from '../../../src/modules/transcript/pending-input.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import { ComposerAnchoredLayout } from '../../../src/presentation/shell/layout/composer-layout.ts'

function fixture(rows: number) {
  const preview = new PendingInputPreview(createTheme(true))
  const conversation = Object.assign(new Text(Array.from({ length: 40 }, (_, index) => `history ${index}`).join('\n'), 0, 0), {
    renderPendingInputs: (width: number, budget: number) => preview.render(width, budget),
  })
  const layout = new ComposerAnchoredLayout(
    new Text('header', 0, 0), conversation,
    new Text('Working', 0, 0), new Text('editor', 0, 0), new Text('footer', 0, 0), () => rows,
  )
  return { preview, conversation, layout }
}

describe('pending input layout', () => {
  it.each([9, 10, 18, 24, 48])('bounds pending input without displacing the editor or hiding the conversation (%i rows)', rows => {
    const { preview, layout } = fixture(rows)
    preview.setItems(Array.from({ length: 100 }, (_, index) => ({
      key: String(index), text: `pending ${index} ${'长'.repeat(200)}`,
      kind: index % 2 === 0 ? 'steering' as const : 'queued' as const,
    })))
    const frame = layout.render(48).map(line => stripTerminalSequences(line).trimEnd())
    const start = frame.findIndex(line => line.startsWith('• Steering'))
    const status = frame.findIndex(line => line === 'Working')
    expect(start).toBeGreaterThan(0)
    expect(status - start).toBeLessThanOrEqual(Math.min(8, Math.floor(rows / 3)))
    expect(frame).toHaveLength(rows)
    expect(frame.some(line => line === 'history 39')).toBe(true)
    expect(frame.some(line => line.startsWith('• Queued'))).toBe(true)
    expect(frame.every(line => visibleWidth(line) <= 48)).toBe(true)
    expect(frame.slice(-3)).toEqual(['Working', 'editor', 'footer'])
  })

  it('keeps a manually scrolled conversation anchored while preview rows appear and disappear', () => {
    const { preview, layout } = fixture(18)
    layout.render(60)
    layout.scrollTranscript(-10)
    const before = layout.render(60).map(line => stripTerminalSequences(line).trimEnd())
    preview.setItems([{ key: 'steer', text: 'new instruction', kind: 'steering' }])
    const pending = layout.render(60).map(line => stripTerminalSequences(line).trimEnd())
    expect(pending[0]).toBe(before[0])
    expect(layout.followsTranscriptTail).toBe(false)
    const previewRow = pending.findIndex(line => line.startsWith('• Steering'))
    expect(layout.transcriptRowAt(previewRow, 0)).toBe(-1)
    preview.setItems([])
    expect(layout.render(60).map(line => stripTerminalSequences(line).trimEnd())).toEqual(before)
  })

  it.each(['scroll to bottom', 'follow latest'] as const)('keeps near-tail reading manual after cancel until an explicit %s', resume => {
    const { preview, conversation, layout } = fixture(24)
    const render = (): string[] => layout.render(80).map(line => stripTerminalSequences(line).trimEnd())
    const append = (last: number): void => {
      conversation.setText(Array.from({ length: last + 1 }, (_, index) => `history ${index}`).join('\n'))
    }
    preview.setItems([{ key: 'steer', text: 'new instruction', kind: 'steering' }])
    const tail = render()
    expect(tail.slice(-5)).toEqual([
      '• Steering · before the next step', '  ↳ new instruction', 'Working', 'editor', 'footer',
    ])
    layout.scrollTranscript(-1)
    expect(render()[0]).toBe('history 21')

    preview.setItems([])
    const canceled = render()
    expect(canceled[0]).toBe('history 20')
    expect(canceled[19]).toBe('history 39')
    expect(layout.followsTranscriptTail).toBe(false)
    expect(layout.transcriptRowAt(0, 0)).toBe(20)
    expect(layout.transcriptRowAt(19, 0)).toBe(39)
    expect(layout.transcriptRowAt(20, 0)).toBe(-1)

    append(40)
    expect(render()).toEqual(canceled)
    expect(layout.followsTranscriptTail).toBe(false)
    layout.scrollTranscript(-1)
    expect(render()[0]).toBe('history 19')

    expect(resume === 'scroll to bottom' ? layout.scrollTranscript(100) : layout.followTranscript()).toBe(true)
    expect(layout.followsTranscriptTail).toBe(true)
    expect(render()).toContain('history 40')
    append(41)
    expect(render()).toContain('history 41')
  })

  it('lets an active surface own the dock and restores current pending input when closed', () => {
    const { preview, layout } = fixture(18)
    preview.setItems([{ key: 'old', text: 'old pending', kind: 'queued' }])
    layout.setActiveSurface({ kind: 'readable', component: new Text('Permission\nAllow once', 0, 0) })
    const surface = layout.render(60).map(line => stripTerminalSequences(line).trimEnd()).join('\n')
    expect(surface).toContain('Permission')
    expect(surface).not.toContain('old pending')
    preview.setItems([{ key: 'new', text: 'current pending', kind: 'steering' }])
    layout.setActiveSurface(undefined)
    expect(layout.render(60).map(line => stripTerminalSequences(line).trimEnd()).join('\n')).toContain('current pending')
  })
})
