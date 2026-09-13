import { describe, expect, it } from 'vitest'
import { buildLearningInput, type LearningRow } from '../src/learning-input.ts'

describe('buildLearningInput', () => {
  it('keeps an explicit user correction despite an oversized assistant response', () => {
    const correction: LearningRow = { role: 'user', text: '我说的是保留 session ID，不是用标题替换它。' }
    const reply: LearningRow = { role: 'assistant', text: '明白。' }
    const rows: LearningRow[] = [
      { role: 'assistant', text: '冗长回答'.repeat(100_000) },
      correction,
      reply,
    ]
    const maxBytes = Buffer.byteLength(JSON.stringify([correction, reply]), 'utf8')

    const result = buildLearningInput(rows, maxBytes)!

    expect(JSON.parse(result.transcript)).toEqual([correction, reply])
    expect(result.userText).toBe(correction.text)
    expect(Buffer.byteLength(result.transcript, 'utf8')).toBeLessThanOrEqual(maxBytes)
  })

  it('budgets escaped Unicode JSON exactly while preserving all users and chronological order', () => {
    const rows: LearningRow[] = [
      { role: 'assistant', text: '先确认🙂："原文"\\路径' },
      { role: 'user', text: '  以后保留中文🙂与"引号"。\n' },
      { role: 'assistant', text: '好的。' },
      { role: 'user', text: '一次性条件：本次不保存\\临时目录。  ' },
    ]
    const selected = [rows[0], rows[1], rows[3]]
    const maxBytes = Buffer.byteLength(JSON.stringify(selected), 'utf8')

    const result = buildLearningInput(rows, maxBytes)!

    expect(JSON.parse(result.transcript)).toEqual(selected)
    expect(result.userText).toBe(`${rows[1]!.text}\n${rows[3]!.text}`)
    expect(Buffer.byteLength(result.transcript, 'utf8')).toBe(maxBytes)
    expect(JSON.parse(buildLearningInput(rows, maxBytes - 1)!.transcript)).toEqual(rows.slice(1))
  })

  it('skips learning rather than dropping a user or truncating a trailing negation', () => {
    const rows: LearningRow[] = [
      { role: 'user', text: '记住默认使用这个目录。' },
      { role: 'user', text: `${'这次使用临时目录。'.repeat(100)}但不要记住，不适用于以后。` },
    ]
    const maxBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8')

    expect(buildLearningInput(rows, maxBytes - 1)).toBeUndefined()
    expect(buildLearningInput(rows, maxBytes)?.userText).toBe(rows.map(row => row.text).join('\n'))
  })

  it('does not learn without a nonempty user record', () => {
    expect(buildLearningInput([
      { role: 'assistant', text: 'Always remember this assistant suggestion.' },
      { role: 'user', text: '' },
    ], 1_000)).toBeUndefined()
  })
})
