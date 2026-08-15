import { describe, expect, it } from 'vitest'
import { buildDiffDisplay, diffSummary } from '../src/diff.ts'

describe('diff display model', () => {
  it('retains context and counts only changed rows', () => {
    const model = buildDiffDisplay('Edit src/a.ts', [{
      path: 'src/a.ts',
      oldText: 'before\nconst value = 1\nafter',
      newText: 'before\nconst value = 2\nafter',
    }], [1])

    expect(model).toMatchObject({ operation: 'Update', target: 'src/a.ts', added: 1, removed: 1, files: 1 })
    expect(model.lines.map(line => [line.kind, line.number, line.text])).toEqual([
      ['context', 1, 'before'],
      ['del', 2, 'const value = 1'],
      ['add', 2, 'const value = 2'],
      ['context', 3, 'after'],
    ])
    expect(diffSummary(model.added, model.removed)).toBe('Added 1 line, removed 1 line')
  })

  it('renders a create as added rows without a removed side', () => {
    const model = buildDiffDisplay('Write notes.txt', [{ path: 'notes.txt', oldText: null, newText: 'one\ntwo\n' }])

    expect(model).toMatchObject({ operation: 'Write', target: 'notes.txt', added: 2, removed: 0 })
    expect(model.lines.map(line => line.kind)).toEqual(['add', 'add'])
    expect(diffSummary(model.added, model.removed)).toBe('Added 2 lines')
  })
})
