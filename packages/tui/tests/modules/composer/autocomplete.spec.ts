import { describe, expect, it, vi } from 'vitest'
import {
  ComposerAutocompleteProvider,
  type FileReferenceSource,
} from '../../../src/modules/composer/autocomplete.ts'
import type { SessionId } from '../../../src/runtime/session/contracts.ts'

function provider() {
  const list = vi.fn<FileReferenceSource['list']>(async () => [
    { path: 'README.md', kind: 'file' },
    { path: 'src', kind: 'directory' },
    { path: 'docs/user guide.md', kind: 'file' },
  ])
  return {
    autocomplete: new ComposerAutocompleteProvider(
      [{ name: 'help', description: 'Show help' }],
      '/workspace',
      'session-1' as SessionId,
      { list },
    ),
    list,
  }
}

describe('ComposerAutocompleteProvider', () => {
  it('maps Host file-reference candidates into the active @ token', async () => {
    const { autocomplete, list } = provider()
    const signal = new AbortController().signal
    const suggestions = await autocomplete.getSuggestions(
      ['inspect @rea'],
      0,
      'inspect @rea'.length,
      { signal },
    )

    expect(list).toHaveBeenCalledWith('session-1', 'rea', signal)
    expect(suggestions).toEqual({
      prefix: '@rea',
      items: [
        { value: '@README.md', label: 'README.md' },
        { value: '@src/', label: 'src/' },
        { value: '@"docs/user guide.md"', label: 'user guide.md', description: 'docs/user guide.md' },
      ],
    })
  })

  it('preserves slash completion through the delegated provider', async () => {
    const { autocomplete, list } = provider()
    const suggestions = await autocomplete.getSuggestions(
      ['/he'],
      0,
      3,
      { signal: new AbortController().signal },
    )

    expect(suggestions).toMatchObject({
      prefix: '/he',
      items: [{ value: 'help', label: 'help', description: 'Show help' }],
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('does not fall through to pi-tui filesystem discovery', async () => {
    const { autocomplete, list } = provider()
    const signal = new AbortController().signal

    await expect(autocomplete.getSuggestions(
      ['./packages'],
      0,
      './packages'.length,
      { signal, force: true },
    )).resolves.toBeNull()
    await expect(autocomplete.getSuggestions(
      ['value=@src'],
      0,
      'value=@src'.length,
      { signal },
    )).resolves.toBeNull()
    expect(list).not.toHaveBeenCalled()
  })
})
