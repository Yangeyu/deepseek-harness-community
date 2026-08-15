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

  it('treats an EOF append as additions without replacing the unchanged last line', () => {
    const unchanged = 'The package identifiers are exact.'
    const model = buildDiffDisplay('Edit README.md', [{
      path: 'README.md',
      oldText: unchanged,
      newText: `${unchanged}\n\nHappy hacking! 🚀\n`,
    }], [75])

    expect(model).toMatchObject({ operation: 'Update', target: 'README.md', added: 2, removed: 0 })
    expect(model.lines.map(line => [line.kind, line.number, line.text])).toEqual([
      ['context', 75, unchanged],
      ['add', 76, ''],
      ['add', 77, 'Happy hacking! 🚀'],
    ])
    expect(diffSummary(model.added, model.removed)).toBe('Added 2 lines')
  })

  it('keeps two context lines around changes and folds distant context', () => {
    const model = buildDiffDisplay('Edit src/a.ts', [{
      path: 'src/a.ts',
      oldText: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine',
      newText: 'one\ntwo\nthree\nfour\nfive\nchanged\nseven\neight\nnine',
    }], [1])

    expect(model.lines.map(line => [line.kind, line.number, line.text])).toEqual([
      ['gap', undefined, '⋯'],
      ['context', 4, 'four'],
      ['context', 5, 'five'],
      ['del', 6, 'six'],
      ['add', 6, 'changed'],
      ['context', 7, 'seven'],
      ['context', 8, 'eight'],
      ['gap', undefined, '⋯'],
    ])
  })
})
