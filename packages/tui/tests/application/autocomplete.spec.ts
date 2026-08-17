import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ComposerAutocompleteProvider,
  extractWorkspaceReferencePrefix,
  listWorkspacePaths,
  type WorkspacePath,
} from '../../src/application/autocomplete.ts'

const WORKSPACE_ROWS: readonly WorkspacePath[] = [
  { path: 'README.md', isDirectory: false },
  { path: 'packages/tui/README.md', isDirectory: false },
  { path: 'src', isDirectory: true },
  { path: 'src/auth.ts', isDirectory: false },
  { path: 'docs/user guide.md', isDirectory: false },
]

function provider(rows: readonly WorkspacePath[] = WORKSPACE_ROWS): ComposerAutocompleteProvider {
  return new ComposerAutocompleteProvider(
    [{ name: 'help', description: 'Show help' }],
    '/workspace',
    vi.fn(async () => rows),
  )
}

describe('workspace path discovery', () => {
  it('returns files and parent directories while respecting ignore rules', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-autocomplete-'))
    try {
      await mkdir(join(cwd, '.git'))
      await mkdir(join(cwd, 'src', 'nested'), { recursive: true })
      await mkdir(join(cwd, '.config'))
      await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n')
      await writeFile(join(cwd, 'README.md'), '')
      await writeFile(join(cwd, 'ignored.txt'), '')
      await writeFile(join(cwd, 'src', 'nested', 'feature.ts'), '')
      await writeFile(join(cwd, '.config', 'settings.json'), '')
      await writeFile(join(cwd, '.git', 'config'), '')

      const paths = await listWorkspacePaths(cwd, new AbortController().signal)

      expect(paths).toEqual(expect.arrayContaining([
        { path: 'README.md', isDirectory: false },
        { path: 'src', isDirectory: true },
        { path: 'src/nested', isDirectory: true },
        { path: 'src/nested/feature.ts', isDirectory: false },
        { path: '.config', isDirectory: true },
        { path: '.config/settings.json', isDirectory: false },
      ]))
      expect(paths).not.toEqual(expect.arrayContaining([
        { path: 'ignored.txt', isDirectory: false },
        { path: '.git/config', isDirectory: false },
      ]))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does no work after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(listWorkspacePaths('/missing', controller.signal)).resolves.toEqual([])
  })
})

describe('ComposerAutocompleteProvider', () => {
  it('recognizes only an active file-reference token', () => {
    expect(extractWorkspaceReferencePrefix('@rea')).toBe('@rea')
    expect(extractWorkspaceReferencePrefix('inspect @src/auth')).toBe('@src/auth')
    expect(extractWorkspaceReferencePrefix('inspect @"docs/user')).toBe('@"docs/user')
    expect(extractWorkspaceReferencePrefix('mail@example.com')).toBeUndefined()
    expect(extractWorkspaceReferencePrefix('inspect @src done')).toBeUndefined()
  })

  it('fuzzy-filters workspace paths for @ input', async () => {
    const autocomplete = provider()
    const suggestions = await autocomplete.getSuggestions(
      ['inspect @rea'],
      0,
      'inspect @rea'.length,
      { signal: new AbortController().signal },
    )

    expect(suggestions?.prefix).toBe('@rea')
    expect(suggestions?.items.map(item => item.value)).toEqual([
      '@README.md',
      '@packages/tui/README.md',
    ])
  })

  it('preserves slash completion through the delegated provider', async () => {
    const suggestions = await provider().getSuggestions(
      ['/he'],
      0,
      3,
      { signal: new AbortController().signal },
    )

    expect(suggestions).toMatchObject({
      prefix: '/he',
      items: [{ value: 'help', label: 'help', description: 'Show help' }],
    })
  })

  it('inserts files, directories, and paths containing spaces', async () => {
    const autocomplete = provider()
    const controller = new AbortController()
    const file = await autocomplete.getSuggestions(['@rea'], 0, 4, { signal: controller.signal })
    const directory = await autocomplete.getSuggestions(['@src'], 0, 4, { signal: controller.signal })
    const spaced = await autocomplete.getSuggestions(['@guide'], 0, 6, { signal: controller.signal })

    expect(autocomplete.applyCompletion(['@rea'], 0, 4, file!.items[0]!, file!.prefix)).toMatchObject({
      lines: ['@README.md '],
      cursorCol: 11,
    })
    expect(autocomplete.applyCompletion(['@src'], 0, 4, directory!.items[0]!, directory!.prefix)).toMatchObject({
      lines: ['@src/'],
      cursorCol: 5,
    })
    expect(autocomplete.applyCompletion(['@guide'], 0, 6, spaced!.items[0]!, spaced!.prefix)).toMatchObject({
      lines: ['@"docs/user guide.md" '],
      cursorCol: 22,
    })
  })

  it('drops paths that cannot be represented safely in the prompt', async () => {
    const suggestions = await provider([
      { path: '../outside.ts', isDirectory: false },
      { path: 'src/../../outside.ts', isDirectory: false },
      { path: '.git/config', isDirectory: false },
      { path: 'nested/.git', isDirectory: true },
      { path: 'docs/unsafe"name.md', isDirectory: false },
    ]).getSuggestions(['@'], 0, 1, { signal: new AbortController().signal })

    expect(suggestions).toBeNull()
  })
})
