import {
  Editor,
  getKeybindings,
  Key,
  matchesKey,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from '@earendil-works/pi-tui'
import {
  decodeEditorImageReferences,
  encodeEditorImageReferences,
  paintKnownImageReferences,
} from './image-references.ts'

type Paint = (text: string) => string

const CURSOR_LEFT = '\u001b[D'
const CURSOR_RIGHT = '\u001b[C'

interface CursorPosition {
  line: number
  col: number
}

interface ReferenceOccurrence {
  readonly reference: string
  readonly position: CursorPosition
}

function sameCursor(left: CursorPosition, right: CursorPosition): boolean {
  return left.line === right.line && left.col === right.col
}

function cursorAtOffset(text: string, offset: number): CursorPosition {
  const prefix = text.slice(0, offset)
  const lines = prefix.split('\n')
  return { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 }
}

function offsetAtPosition(lines: readonly string[], position: CursorPosition): number {
  let offset = position.col
  for (let line = 0; line < position.line; line += 1) {
    offset += (lines[line]?.length ?? 0) + 1
  }
  return offset
}

function occurrenceOrdinal(text: string, reference: string, target: number): number | undefined {
  let ordinal = 0
  let offset = text.indexOf(reference)
  while (offset >= 0) {
    if (offset === target) return ordinal
    if (offset > target) return undefined
    ordinal += 1
    offset = text.indexOf(reference, offset + reference.length)
  }
  return undefined
}

function occurrenceAt(text: string, reference: string, ordinal: number): number {
  let offset = text.indexOf(reference)
  for (let index = 0; index < ordinal && offset >= 0; index += 1) {
    offset = text.indexOf(reference, offset + reference.length)
  }
  return offset
}

/** Repository-owned image-reference behavior over the public pi-tui Editor API. */
export class InlineReferenceEditor extends Editor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly references: () => readonly string[],
    private readonly paintReference: Paint,
    options?: EditorOptions,
  ) {
    super(tui, theme, options)
  }

  override handleInput(data: string): void {
    const bindings = getKeybindings()
    const before = this.referenceBeforeCursor()
    const after = this.referenceAfterCursor()

    if (before !== undefined && (
      bindings.matches(data, 'tui.editor.deleteCharBackward')
      || bindings.matches(data, 'tui.editor.deleteWordBackward')
      || matchesKey(data, Key.shift(Key.backspace))
    )) {
      this.deleteReference(before)
      return
    }
    if (after !== undefined && (
      bindings.matches(data, 'tui.editor.deleteCharForward')
      || bindings.matches(data, 'tui.editor.deleteWordForward')
      || matchesKey(data, Key.shift(Key.delete))
    )) {
      this.deleteReference(after)
      return
    }
    if (before !== undefined && (
      bindings.matches(data, 'tui.editor.cursorLeft')
      || bindings.matches(data, 'tui.editor.cursorWordLeft')
    )) {
      this.stepCursor(CURSOR_LEFT, before.reference.length)
      return
    }
    if (after !== undefined && (
      bindings.matches(data, 'tui.editor.cursorRight')
      || bindings.matches(data, 'tui.editor.cursorWordRight')
    )) {
      this.stepCursor(CURSOR_RIGHT, after.reference.length)
      return
    }

    const previous = this.getCursor()
    super.handleInput(data)
    this.snapCursorOutsideReference(previous)
  }

  override render(width: number): string[] {
    const references = this.activeReferences()
    return super.render(width)
      .map(line => paintKnownImageReferences(line, references, this.paintReference))
  }

  override getText(): string {
    return decodeEditorImageReferences(super.getText(), this.activeReferences())
  }

  override getExpandedText(): string {
    return decodeEditorImageReferences(super.getExpandedText(), this.activeReferences())
  }

  override getLines(): string[] {
    const references = this.activeReferences()
    return super.getLines().map(line => decodeEditorImageReferences(line, references))
  }

  override setText(text: string): void {
    super.setText(encodeEditorImageReferences(text, this.activeReferences()))
  }

  override insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(encodeEditorImageReferences(text, this.activeReferences()))
  }

  override addToHistory(text: string): void {
    super.addToHistory(encodeEditorImageReferences(text, this.activeReferences()))
  }

  private activeReferences(): readonly string[] {
    return [...new Set(this.references())]
      .filter(reference => reference !== '')
      .sort((left, right) => right.length - left.length)
  }

  private referenceBeforeCursor(): ReferenceOccurrence | undefined {
    const cursor = this.getCursor()
    const line = this.getLines()[cursor.line] ?? ''
    const reference = this.activeReferences().find(candidate => (
      cursor.col >= candidate.length
      && line.slice(cursor.col - candidate.length, cursor.col) === candidate
    ))
    return reference === undefined
      ? undefined
      : { reference, position: { line: cursor.line, col: cursor.col - reference.length } }
  }

  private referenceAfterCursor(): ReferenceOccurrence | undefined {
    const cursor = this.getCursor()
    const line = this.getLines()[cursor.line] ?? ''
    const reference = this.activeReferences().find(candidate => line.startsWith(candidate, cursor.col))
    return reference === undefined ? undefined : { reference, position: cursor }
  }

  private deleteReference(occurrence: ReferenceOccurrence): void {
    const lines = this.getLines()
    const source = lines.join('\n')
    const sourceOffset = offsetAtPosition(lines, occurrence.position)
    const ordinal = occurrenceOrdinal(source, occurrence.reference, sourceOffset)
    if (ordinal === undefined) return
    const text = this.getExpandedText()
    const index = occurrenceAt(text, occurrence.reference, ordinal)
    if (index < 0) return
    const next = `${text.slice(0, index)}${text.slice(index + occurrence.reference.length)}`
    this.setText(next)
    this.moveCursorTo(cursorAtOffset(next, index))
  }

  private moveCursorTo(target: CursorPosition): void {
    let remaining = this.getExpandedText().length + this.getLines().length
    while (!sameCursor(this.getCursor(), target) && remaining > 0) {
      const previous = this.getCursor()
      super.handleInput(CURSOR_LEFT)
      if (sameCursor(previous, this.getCursor())) break
      remaining -= 1
    }
  }

  private stepCursor(data: string, count: number): void {
    for (let index = 0; index < count; index += 1) super.handleInput(data)
  }

  private snapCursorOutsideReference(previous: CursorPosition): void {
    const cursor = this.getCursor()
    const line = this.getLines()[cursor.line] ?? ''
    for (const reference of this.activeReferences()) {
      let start = line.indexOf(reference)
      while (start >= 0) {
        const end = start + reference.length
        if (cursor.col > start && cursor.col < end) {
          const moveLeft = previous.line === cursor.line
            ? previous.col >= end
            : cursor.col - start <= end - cursor.col
          this.stepCursor(moveLeft ? CURSOR_LEFT : CURSOR_RIGHT, moveLeft ? cursor.col - start : end - cursor.col)
          return
        }
        start = line.indexOf(reference, end)
      }
    }
  }
}
