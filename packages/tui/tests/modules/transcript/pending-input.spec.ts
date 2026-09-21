import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { PendingInputItem } from '../../../src/modules/transcript/model.ts'
import { PendingInputPreview } from '../../../src/modules/transcript/pending-input.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'

function preview(items: readonly PendingInputItem[], color = false): PendingInputPreview {
  const component = new PendingInputPreview(createTheme(color))
  component.setItems(items)
  return component
}

const item = (key: string, text: string, kind: PendingInputItem['kind'] = 'steering'): PendingInputItem => ({ key, text, kind })

describe('pending input preview', () => {
  it('groups steering before queued while preserving each group’s projected order', () => {
    const component = preview([
      item('q1', 'Queued first', 'queued'),
      item('s1', 'Please check the current result first.'),
      item('q2', 'Queued second', 'queued'),
      item('s2', 'Then inspect the next step.'),
    ])
    expect(component.render(80)).toEqual([
      '• Steering · before the next step',
      '  ↳ Please check the current result first.',
      '  ↳ Then inspect the next step.',
      '• Queued · after this turn',
      '  ↳ Queued first',
      '  ↳ Queued second',
    ])
  })

  it('distinguishes group titles from subdued pending text without changing layout', () => {
    const items = [item('s', 'Check the result first.'), item('q', 'Run tests later.', 'queued')]
    const theme = createTheme(true)
    const component = preview(items, true)
    expect(component.render(80)).toEqual([
      theme.secondary('• Steering') + theme.dim(' · before the next step'),
      theme.dim('  ↳ Check the result first.'),
      theme.secondary('• Queued') + theme.dim(' · after this turn'),
      theme.dim('  ↳ Run tests later.'),
    ])
    expect(component.render(24).map(stripTerminalSequences)).toEqual(preview(items).render(24).map(stripTerminalSequences))
  })

  it.each(['steering', 'queued'] as const)('keeps a title for a single %s group without padding rows', (kind) => {
    const rows = preview([item('one', 'Keep this instruction readable.', kind)]).render(80)
    expect(rows).toEqual([
      kind === 'steering' ? '• Steering · before the next step' : '• Queued · after this turn',
      '  ↳ Keep this instruction readable.',
    ])
  })

  it.each([undefined, 16])('caps previews at eight rows and reports exact undisplayed item counts (budget: %s)', budget => {
    const component = preview(Array.from({ length: 1000 }, (_, index) => item(
      String(index),
      `Instruction ${index}`,
      index < 500 ? 'steering' : 'queued',
    )))
    const rows = component.render(80, budget)
    expect(rows).toHaveLength(8)
    expect(rows[0]).toBe('• Steering · 497 hidden · before the next step')
    expect(rows.slice(1, 4)).toEqual(['  ↳ Instruction 0', '  ↳ Instruction 1', '  ↳ Instruction 2'])
    expect(rows[4]).toBe('• Queued · 497 hidden · after this turn')
    expect(rows.slice(5)).toEqual(['  ↳ Instruction 500', '  ↳ Instruction 501', '  ↳ Instruction 502'])
  })

  it('keeps both kinds identifiable in small budgets and uses accurate one-row counts', () => {
    const component = preview([
      item('s1', 'First'), item('s2', 'Second'),
      item('q1', 'Later', 'queued'),
    ])
    expect(component.render(80, 0)).toEqual([])
    expect(component.render(80, 1)).toEqual(['• Steering 2 · Queued 1'])
    expect(component.render(12, 1)).toEqual(['S:2 Q:1'])
    expect(component.render(80, 2)).toEqual([
      '• Steering · 2 hidden · before the next step',
      '• Queued · 1 hidden · after this turn',
    ])
    expect(component.render(80, 4)).toEqual([
      '• Steering · 1 hidden · before the next step',
      '  ↳ First',
      '• Queued · after this turn',
      '  ↳ Later',
    ])
  })

  it('gives spare rows from a short group to the other kind', () => {
    const component = preview([
      item('s', 'Current'),
      ...Array.from({ length: 10 }, (_, index) => item(`q${index}`, `Later ${index}`, 'queued')),
    ])
    const rows = component.render(80)
    expect(rows).toHaveLength(8)
    expect(rows[2]).toBe('• Queued · 5 hidden · after this turn')
    expect(rows.at(-1)).toBe('  ↳ Later 4')
  })

  it('flattens multiline bodies into readable bounded previews with explicit omission', () => {
    const component = preview([
      item('short', 'First line\nsecond line\tthird line'),
      item('long', 'Readable opening.\n' + 'lots of text\n'.repeat(100_000)),
    ])
    const rows = component.render(50).map(stripTerminalSequences)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toBe('  ↳ First line second line third line')
    expect(rows[2]).toMatch(/^  ↳ Readable opening\..*…$/u)
    expect(visibleWidth(rows[2]!)).toBeLessThanOrEqual(50)
    // Even a very wide terminal does not expand an entire pasted document.
    expect(component.render(10_000)[2]!.length).toBeLessThan(4200)
    expect(component.render(10_000)[2]).toMatch(/…$/u)
  })

  it('preserves Unicode graphemes and never overflows narrow terminal columns', () => {
    const text = '中文 👩🏽‍💻 e\u0301 👨‍👩‍👧‍👦 继续'
    const component = preview([item('unicode', text)], true)
    expect(stripTerminalSequences(component.render(80)[1]!)).toBe(`  ↳ ${text}`)
    const expectedGraphemes = new Set(Array.from(new Intl.Segmenter().segment(`  ↳ ${text}…`), part => part.segment))
    for (let width = 0; width <= 40; width++) {
      const rows = component.render(width)
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      const body = stripTerminalSequences(rows[1] ?? '')
      for (const part of new Intl.Segmenter().segment(body)) expect(expectedGraphemes.has(part.segment)).toBe(true)
    }
    expect(component.render(0)).toEqual([])
  })

  it('removes terminal sequences and control bytes rather than executing or displaying their payloads', () => {
    const malicious = 'Hello\u001b[31m red\u001b[0m\u001b[2J\u001b]52;c;clipboard-secret\u0007'
      + '\u001b]8;;https://example.test\u001b\\ link\u001b]8;;\u001b\\'
      + '\u001b_Gimage-payload\u001b\\\u0000\u0007\u0008\u009b\r\nworld'
    const rows = preview([item('unsafe', malicious)]).render(100)
    expect(rows[1]).toBe('  ↳ Hello red link world')
    expect(rows.join('\n')).not.toContain('\u001b')
  })

  it('renders empty input as nothing and replaces or clears the current projection immediately', () => {
    const component = new PendingInputPreview(createTheme(false))
    expect(component.render(80)).toEqual([])
    component.setItems([item('one', 'Old')])
    expect(component.render(80)[1]).toBe('  ↳ Old')
    component.setItems([item('one', 'Updated', 'queued')])
    component.invalidate()
    expect(component.render(80)).toEqual(['• Queued · after this turn', '  ↳ Updated'])
    component.setItems([])
    expect(component.render(80)).toEqual([])
    component.setItems([item('blank', '\n\t')])
    expect(component.render(80)[1]).toBe('  ↳ (empty)')
  })
})
