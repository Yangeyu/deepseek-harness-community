import {
  Editor,
  SelectList,
  Text,
  type Focusable,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../text.ts'
import type { TuiTheme } from '../theme.ts'
import type { SurfaceInputAction, SurfaceInputTarget } from '../surface-input.ts'

/** Generic keyboard selector used by feature-owned surfaces. */
export class ChoiceDialog implements SurfaceInputTarget {
  readonly inputContext = 'choice' as const
  private readonly title: Text
  private readonly detail: Text | undefined
  private readonly list: SelectList
  private selected = 0

  constructor(
    title: string,
    private readonly items: SelectItem[],
    theme: TuiTheme,
    private readonly onSelect: (item: SelectItem) => void,
    private readonly onCancel: () => void,
    detail?: string,
  ) {
    this.title = new Text(theme.bold(sanitizeTerminalText(title)), 1, 0)
    this.detail = detail === undefined ? undefined : new Text(theme.dim(sanitizeTerminalText(detail)), 1, 0)
    this.list = new SelectList(items, 10, theme.select)
    this.list.onSelect = onSelect
    this.list.onCancel = onCancel
  }

  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.previous') this.move(-1)
    else if (action === 'surface.next') this.move(1)
    else if (action === 'surface.confirm') {
      const selected = this.items[this.selected]
      if (selected !== undefined) this.onSelect(selected)
    } else if (action === 'surface.back' || action === 'surface.cancel') this.onCancel()
  }

  invalidate(): void {
    this.title.invalidate()
    this.detail?.invalidate()
    this.list.invalidate()
  }

  render(width: number): string[] {
    return [
      ...this.title.render(width),
      ...this.detail?.render(width) ?? [],
      '',
      ...this.list.render(width),
    ]
  }

  private move(direction: -1 | 1): void {
    if (this.items.length === 0) return
    this.selected = (this.selected + direction + this.items.length) % this.items.length
    this.list.setSelectedIndex(this.selected)
  }
}

/** One-line custom-answer surface backed by pi-tui's IME-aware editor. */
export class TextInputDialog implements SurfaceInputTarget, Focusable {
  readonly inputContext = 'text-input' as const
  private readonly editor: Editor

  constructor(
    tui: TUI,
    private readonly title: string,
    private readonly theme: TuiTheme,
    onSubmit: (text: string) => void,
    private readonly onCancel: () => void,
    initial = '',
  ) {
    this.editor = new Editor(tui, theme.editor, { paddingX: 0, autocompleteMaxVisible: 5 })
    if (initial !== '') this.editor.setText(initial)
    this.editor.onSubmit = onSubmit
  }

  get focused(): boolean {
    return this.editor.focused
  }

  set focused(value: boolean) {
    this.editor.focused = value
  }

  handleInput(data: string): void {
    this.editor.handleInput(data)
  }

  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.back' || action === 'surface.cancel') this.onCancel()
  }

  invalidate(): void {
    this.editor.invalidate()
  }

  render(width: number): string[] {
    return [
      this.theme.bold(sanitizeTerminalText(this.title)),
      '',
      ...this.editor.render(width),
    ]
  }
}
