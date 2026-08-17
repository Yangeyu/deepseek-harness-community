import { describe, expect, it } from 'vitest'
import {
  mergeSlashCatalog,
  resolveLeadingSlash,
  slashAutocompleteRows,
  slashHelpText,
} from '../../src/runtime/slash-catalog.ts'

describe('slash catalog', () => {
  const commands = [
    { name: 'status', description: 'Show status' },
    { name: 'release', description: 'Host release command' },
  ]
  const skills = [
    { name: 'review', description: 'Review changes', modelInvocable: true },
    { name: 'release', description: 'Release workflow', modelInvocable: false },
  ]

  it('keeps commands ahead of skills and removes colliding skills', () => {
    const catalog = mergeSlashCatalog(commands, skills)

    expect(catalog.map(row => `${row.kind}:${row.name}`)).toEqual([
      'command:status',
      'command:release',
      'skill:review',
    ])
  })

  it('also reserves hidden local aliases against Skill collisions', () => {
    const catalog = mergeSlashCatalog(commands, [
      ...skills,
      { name: 'trace', description: 'Trace Skill', modelInvocable: true },
    ], ['status', 'release', 'trajectory', 'trace'])

    expect(catalog.some(row => row.kind === 'skill' && row.name === 'trace')).toBe(false)
  })

  it('resolves an exact Skill without rewriting its prompt', () => {
    const catalog = mergeSlashCatalog(commands, skills)

    expect(resolveLeadingSlash('/review focus on races', catalog)).toEqual({
      kind: 'skill',
      candidate: expect.objectContaining({ name: 'review' }),
    })
    expect(resolveLeadingSlash('explain /review', catalog)).toEqual({ kind: 'none' })
    expect(resolveLeadingSlash('/Users/name/project/README.md update this file', catalog)).toEqual({ kind: 'none' })
    expect(resolveLeadingSlash('/missing', catalog)).toEqual({ kind: 'unknown', name: 'missing' })
  })

  it('labels Skills without changing command autocomplete vocabulary', () => {
    expect(slashAutocompleteRows(mergeSlashCatalog(commands, skills))).toEqual([
      { name: 'status', description: 'Show status' },
      { name: 'release', description: 'Host release command' },
      { name: 'review', description: 'Skill · Review changes', argumentHint: '[request]' },
    ])
  })

  it('builds grouped help from the same effective candidates', () => {
    expect(slashHelpText(mergeSlashCatalog(commands, skills))).toBe([
      'Commands',
      '/status · Show status',
      '/release · Host release command',
      '',
      'Skills',
      '/review [request] · Review changes',
    ].join('\n'))
  })
})
