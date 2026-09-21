import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, Text } from '@earendil-works/pi-tui'
import type { TranscriptProjection } from '../../../src/modules/transcript/model.ts'
import { TranscriptComponent } from '../../../src/modules/transcript/view.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import { ComposerAnchoredLayout } from '../../../src/presentation/shell/layout/composer-layout.ts'

describe('prompt status layout', () => {
  it.each([9, 10])('keeps prompt geometry stable near the scroll threshold in a %i-row viewport', (viewportRows) => {
    const width = 40
    const body = 'Keep this prompt steady.'
    const projection = (promptStatus?: string): TranscriptProjection => ({
      items: [{ kind: 'prompt', key: 'prompt:message-1', body, ...promptStatus === undefined ? {} : { promptStatus } }],
      activeActivityKey: undefined,
      showDetails: false,
    })
    const transcript = new TranscriptComponent(projection(), createTheme(true))
    // A fixed three-row composer leaves five or six conversation rows:
    // header + gap + the existing three-row prompt, with at most one spare row.
    const layout = new ComposerAnchoredLayout(
      new Text('header', 0, 0),
      transcript,
      new Text('Ready', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => viewportRows,
    )
    const initial = layout.render(width).map(stripTerminalSequences)
    const bodyRow = initial.findIndex(line => line.includes(body))
    const bodyColumn = initial[bodyRow]!.indexOf(body)
    expect(bodyRow).toBeGreaterThan(0)

    for (const status of [undefined, 'Queueing…', 'Queued', 'Steering…', 'Steering next step…', undefined]) {
      transcript.setProjection(projection(status))
      const frame = layout.render(width).map(stripTerminalSequences)
      const prompt = transcript.render(width).map(stripTerminalSequences)

      // Status occupies the existing bottom padding, never an additional row.
      expect(prompt).toHaveLength(3)
      expect(prompt.at(-1)?.trim()).toBe(status ?? '')
      expect(frame).toHaveLength(viewportRows)
      expect(frame.findIndex(line => line.includes(body))).toBe(bodyRow)
      expect(frame[bodyRow]!.indexOf(body)).toBe(bodyColumn)
      expect(frame[bodyRow + 1]?.trim()).toBe(status ?? '')
      expect(frame.findIndex(line => line.trim() === 'editor')).toBe(viewportRows - 2)
    }
  })
})
