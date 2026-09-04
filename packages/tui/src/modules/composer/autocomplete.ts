import { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@earendil-works/pi-tui'
import type { SessionId } from '../../runtime/session/contracts.ts'

/** Consumer-owned boundary for Host-scoped file-reference discovery. */
export interface FileReferenceSource {
  list(
    sessionId: SessionId,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly FileReferenceCandidate[]>
}

function completionItem(
  candidate: FileReferenceCandidate,
  preserveQuote: boolean,
): AutocompleteItem | undefined {
  const value = formatFileMention(candidate, preserveQuote)
  if (value === undefined) return undefined

  const displayPath = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path
  const separator = candidate.path.lastIndexOf('/')
  const label = candidate.path.slice(separator + 1) + (candidate.kind === 'directory' ? '/' : '')
  return {
    value,
    label,
    ...label === displayPath ? {} : { description: displayPath },
  }
}

/** Adapt Host file-reference candidates and pi-tui slash completion to one Editor contract. */
export class ComposerAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ['@']
  private readonly delegate: CombinedAutocompleteProvider

  constructor(
    commands: readonly (AutocompleteItem | SlashCommand)[],
    cwd: string,
    private readonly sessionId: SessionId | undefined,
    private readonly fileReferences: FileReferenceSource,
  ) {
    this.delegate = new CombinedAutocompleteProvider([...commands], cwd)
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? ''
    const token = activeAtToken(line, cursorCol)
    if (token === undefined) {
      const beforeCursor = line.slice(0, cursorCol)
      if (cursorLine !== 0 || !beforeCursor.startsWith('/')) return null
      return await this.delegate.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        { ...options, force: false },
      )
    }
    if (this.sessionId === undefined) return null

    const candidates = await this.fileReferences.list(this.sessionId, token.query, options.signal)
    if (options.signal.aborted) return null
    const items = candidates.flatMap((candidate) => {
      const item = completionItem(candidate, token.quoted)
      return item === undefined ? [] : [item]
    })
    return items.length === 0 ? null : { items, prefix: token.prefix }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }
}
