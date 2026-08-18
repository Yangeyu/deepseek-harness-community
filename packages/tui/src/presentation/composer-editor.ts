import {
  stripTerminalSequences,
  type Component,
} from '@earendil-works/pi-tui'

interface EditorRender {
  autocomplete: string[]
  frame: string[]
}

function isEditorBorder(line: string): boolean {
  return stripTerminalSequences(line).startsWith('─')
}

function splitEditorRender(lines: string[]): EditorRender {
  const closingBorder = lines.findIndex((line, index) => index > 0 && isEditorBorder(line))
  if (closingBorder < 0 || closingBorder === lines.length - 1) {
    return { autocomplete: [], frame: lines }
  }
  return {
    autocomplete: lines.slice(closingBorder + 1),
    frame: lines.slice(0, closingBorder + 1),
  }
}

/** Keeps autocomplete above the bottom-anchored Editor. */
export class ComposerEditorFrame implements Component {
  constructor(private readonly editor: Component) {}

  handleInput(data: string): void {
    this.editor.handleInput?.(data)
  }

  invalidate(): void {
    this.editor.invalidate()
  }

  render(width: number): string[] {
    const rendered = splitEditorRender(this.editor.render(width))
    return [...rendered.autocomplete, ...rendered.frame]
  }
}
