import { describe, expect, it } from 'vitest'
import { buildLearningInput, type LearningRow } from '../src/learning-input.ts'

describe('buildLearningInput', () => {
  it('keeps an explicit user correction despite an oversized assistant response', () => {
    const correction: LearningRow = { role: 'user', text: '我说的是保留 session ID，不是用标题替换它。' }
    const rows: LearningRow[] = [
      { role: 'assistant', text: '冗长回答'.repeat(1_000) },
      correction,
      { role: 'assistant', text: '明白。' },
    ]
    const result = buildLearningInput(1, rows, 512)!

    expect(JSON.parse(result)).toEqual({ turn: 1, messages: [correction] })
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(512)
  })

  it('includes the complete conversation in order when it fits', () => {
    const rows: LearningRow[] = [
      { role: 'user', text: '  以后保留中文🙂与"引号"。\n' },
      { role: 'assistant', text: '好的，临时目录也保存吗？' },
      { role: 'user', text: '本次不保存\\临时目录。' },
    ]
    expect(JSON.parse(buildLearningInput(2, rows, 1_000)!)).toEqual({ turn: 2, messages: rows })
  })

  it('skips learning rather than dropping a user or truncating a trailing negation', () => {
    const rows: LearningRow[] = [
      { role: 'user', text: '记住默认使用这个目录。' },
      { role: 'user', text: `${'这次使用临时目录。'.repeat(100)}但不要记住，不适用于以后。` },
    ]
    const maxBytes = Buffer.byteLength(JSON.stringify({ turn: 1, messages: rows }), 'utf8')

    expect(buildLearningInput(1, rows, maxBytes - 1)).toBeUndefined()
    expect(JSON.parse(buildLearningInput(1, rows, maxBytes)!)).toEqual({ turn: 1, messages: rows })
  })

  it('does not learn without a nonempty user record', () => {
    expect(buildLearningInput(1, [
      { role: 'assistant', text: 'Always remember this assistant suggestion.' },
      { role: 'user', text: '' },
    ], 1_000)).toBeUndefined()
  })
})
