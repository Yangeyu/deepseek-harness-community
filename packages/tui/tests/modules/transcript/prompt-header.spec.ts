import { describe, expect, it } from 'vitest'
import { Text, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { TranscriptComponent } from '../../../src/modules/transcript/view.ts'
import type { TranscriptItem } from '../../../src/modules/transcript/model.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import { ComposerAnchoredLayout } from '../../../src/presentation/shell/layout/composer-layout.ts'
import { RenderedTextSelection } from '../../../src/presentation/shell/screen/text-selection.ts'

const prompt = (key: string, body: string): TranscriptItem => ({ kind: 'prompt', key, body })
const answer = (key: string, rows: number): TranscriptItem => ({
  kind: 'text', key, body: Array.from({ length: rows }, (_, i) => `${key} ${i + 1}`).join('\n'),
})

function fixture(items: readonly TranscriptItem[], rows = 10) {
  const transcript = new TranscriptComponent({ items, pendingInputs: [], activeActivityKey: undefined, showDetails: false }, createTheme(false))
  const layout = new ComposerAnchoredLayout(
    new Text('', 0, 0), transcript, new Text('', 0, 0), new Text('editor', 0, 0), new Text('', 0, 0), () => rows,
  )
  return {
    transcript, layout,
    resize: (height: number) => { rows = height },
    render: (width = 40) => layout.render(width).map(line => stripTerminalSequences(line).trimEnd()),
  }
}

describe('reading prompt header', () => {
  it('tracks the answer being read, yields to its visible prompt, and jumps by identity after reflow and prepending', () => {
    const items = [prompt('first', 'First question'), answer('first answer', 12), prompt('second', 'Second question'), answer('second answer', 12)]
    const { transcript, layout, render } = fixture(items)
    expect(render()[0]).toBe(' › Second question')
    expect(layout.transcriptRowAt(0, 0)).toBe(-1)
    expect(layout.promptHeaderKeyAt(0, 0)).toBe('second')
    layout.scrollTranscript(-17)
    expect(render()[0]).toBe(' › First question')
    expect(layout.promptHeaderKeyAt(0, 0)).toBe('first')

    const key = layout.promptHeaderKeyAt(0, 0)!
    expect(layout.jumpToPrompt(key)).toBe(true)
    // History and width may change between the release and the scheduled frame.
    transcript.setProjection({ items: [prompt('older', 'Older question'), answer('older answer', 20), ...items], pendingInputs: [], activeActivityKey: undefined, showDetails: false })
    const jumped = render(20)
    expect(jumped[1]).toBe(' › First question')
    expect(layout.promptHeaderKeyAt(0, 0)).toBeUndefined()
    expect(layout.transcriptRowAt(0, 0)).toBe(transcript.promptRow('first'))
    expect(layout.followsTranscriptTail).toBe(false)
    layout.followTranscript()
    expect(render()[0]).toBe(' › Second question')
    expect(render()).toContain(' second answer 12')
  })

  it('bounds and sanitizes the summary, retaining terminal-width and short-screen rules', () => {
    const { layout, render, resize } = fixture([
      prompt('first', '\u001b[31m界 café\r\nnext question\u0007' + '🙂'.repeat(1000)), answer('answer', 20),
    ])
    const header = render(18)[0]!
    expect(header).toBe(' › 界 café next …')
    expect(visibleWidth(header)).toBeLessThanOrEqual(18)
    expect(layout.promptHeaderKeyAt(0, 0)).toBe('first')
    render(15)
    expect(layout.promptHeaderKeyAt(0, 0)).toBeUndefined()
    resize(5)
    render()
    expect(layout.promptHeaderKeyAt(0, 0)).toBeUndefined()
  })

  it('keeps held reading stable and excludes the header from text selection', () => {
    const { layout, render } = fixture([prompt('first', 'First question'), answer('answer', 20)])
    const before = render()
    const selection = new RenderedTextSelection(row => layout.isSelectableRow(row))
    selection.begin({ row: 2, col: 39 })
    layout.preserveTranscriptViewport()
    expect(render()).toEqual(before)
    selection.update({ row: 0, col: 0 })
    const highlighted = selection.apply(render())
    expect(highlighted[0]).not.toContain('\u001b[7m')
    const result = selection.finish({ row: 0, col: 0 }, render())
    expect(result).toMatchObject({ kind: 'selection', text: before.slice(1, 3).join('\n').trimEnd() })
    expect(render()).toEqual(before)
    selection.clear()
    expect(render()).toEqual(before)
  })

  it('does not oscillate when reserving the header would expose the next prompt', () => {
    const { layout, render } = fixture([prompt('first', 'First'), answer('answer', 10), prompt('second', 'Second'), answer('next', 4)], 12)
    // Ten conversation rows: the top is the previous answer's last row. Reserving a row
    // would expose the next prompt's separator, so the header yields for this viewport.
    const before = render()
    expect(before[0]).toBe(' answer 10')
    expect(layout.promptHeaderKeyAt(0, 0)).toBeUndefined()
    layout.preserveTranscriptViewport()
    expect(render()).toEqual(before)
    expect(render()).toEqual(before)
    layout.scrollTranscript(-2)
    expect(render()[0]).toBe(' › First')
  })
})
