import type { Component, Focusable } from '@earendil-works/pi-tui'
import type { ComposerAutocompleteProvider } from './autocomplete.ts'

export interface ComposerCursor {
  readonly line: number
  readonly col: number
}

/** Narrow editor capability consumed by the Composer process. */
export interface ComposerEditorPort extends Component, Focusable {
  onChange?: (text: string) => void
  onSubmit?: (text: string) => void
  handleInput(data: string): void
  setAutocompleteProvider(provider: ComposerAutocompleteProvider): void
  isShowingAutocomplete(): boolean
  getText(): string
  getExpandedText(): string
  getLines(): string[]
  getCursor(): ComposerCursor
  setText(text: string): void
  insertTextAtCursor(text: string): void
  addToHistory(text: string): void
  decodeReferences(text: string): string
}

export type ComposerEditorFactory = (
  references: () => readonly string[],
) => ComposerEditorPort
