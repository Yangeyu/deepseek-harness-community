import {
  Editor,
  Key,
  SelectList,
  Text,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui'
import type {
  ModelReasoningEffort,
  ModelSelection,
  SessionModels,
} from '@deepseek-ai/dsh-host-apiproxy'
import { sanitizeTerminalText } from './text.ts'
import type { TuiTheme } from './theme.ts'
import type { RewindPreview } from './checkpoint.ts'

/** Keyboard selector with a title and optional explanatory line. */
export class ChoiceDialog implements Component {
  private readonly title: Text
  private readonly detail: Text | undefined
  private readonly list: SelectList

  constructor(
    title: string,
    items: SelectItem[],
    theme: TuiTheme,
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
    detail?: string,
  ) {
    this.title = new Text(theme.bold(sanitizeTerminalText(title)), 1, 0)
    this.detail = detail === undefined ? undefined : new Text(theme.dim(sanitizeTerminalText(detail)), 1, 0)
    this.list = new SelectList(items, 10, theme.select)
    this.list.onSelect = onSelect
    this.list.onCancel = onCancel
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
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
}

interface ModelRow {
  providerId: string
  providerName: string
  model: SessionModels['groups'][number]['models'][number]
}

interface EffortChoice {
  id: string | undefined
  name: string
  description?: string
}

function effortChoices(row: ModelRow): EffortChoice[] {
  const reasoning = row.model.reasoning
  if (reasoning === undefined) return []
  return [
    ...reasoning.defaultEffort === undefined
      ? [{ id: undefined, name: 'Provider default' }]
      : [],
    ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
      id: effort.id,
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })),
  ]
}

/** Codex-style two-stage model and reasoning-effort selector. */
export class ModelDialog implements Component {
  private readonly rows: ModelRow[]
  private index: number
  private stage: 'model' | 'effort' = 'model'
  private effortIndex = 0

  constructor(
    private readonly models: SessionModels,
    private readonly theme: TuiTheme,
    private readonly onSelect: (selection: ModelSelection) => void,
    private readonly onCancel: () => void,
  ) {
    this.rows = models.groups.flatMap(group => group.models.map(model => ({
      providerId: group.id,
      providerName: group.name,
      model,
    })))
    const current = this.rows.findIndex(row =>
      row.providerId === models.current.provider && row.model.id === models.current.model)
    this.index = Math.max(0, current)
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.move(-1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.move(1)
      return
    }
    if (/^[1-9]$/.test(data)) {
      const selected = Number(data) - 1
      if (this.stage === 'model') {
        if (selected < this.rows.length) this.index = selected
      } else if (selected < this.currentEfforts().length) {
        this.effortIndex = selected
      }
      return
    }
    if (matchesKey(data, Key.enter)) {
      this.confirm()
      return
    }
    if (matchesKey(data, Key.escape)) {
      if (this.stage === 'effort') this.stage = 'model'
      else this.onCancel()
      return
    }
    if (matchesKey(data, Key.ctrl('c'))) this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.stage === 'model' ? this.renderModels(width) : this.renderEfforts(width)
  }

  private renderModels(width: number): string[] {
    const lines = [
      this.theme.bold('Select Model and Effort'),
      this.theme.dim('Choose a model. The selection also becomes the default for new sessions.'),
      '',
    ]
    if (this.rows.length === 0) lines.push(this.theme.warning('No models are currently available.'))
    for (const [index, row] of this.rows.entries()) {
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const current = row.providerId === this.models.current.provider && row.model.id === this.models.current.model
      const currentLabel = current ? this.theme.dim(' (current)') : ''
      const description = row.model.description ?? row.providerName
      lines.push(truncateToWidth(
        `${cursor} ${index + 1}. ${index === this.index ? this.theme.bold(row.model.name) : row.model.name}${currentLabel}${description === '' ? '' : `  ${this.theme.dim(description)}`}`,
        width,
      ))
    }
    for (const failure of this.models.failures) {
      lines.push('', truncateToWidth(this.theme.warning(`${failure.name}: ${failure.message}`), width))
    }
    lines.push('', this.theme.dim('Press enter to continue or esc to go back'))
    return lines
  }

  private renderEfforts(width: number): string[] {
    const row = this.rows[this.index]
    const choices = this.currentEfforts()
    const lines = [
      this.theme.bold('Select Reasoning Effort'),
      this.theme.dim(row?.model.name ?? ''),
      '',
    ]
    for (const [index, choice] of choices.entries()) {
      const cursor = index === this.effortIndex ? this.theme.accent('›') : ' '
      const current = row?.providerId === this.models.current.provider
        && row.model.id === this.models.current.model
        && choice.id === this.models.current.reasoningEffort
      const currentLabel = current ? this.theme.dim(' (current)') : ''
      lines.push(truncateToWidth(
        `${cursor} ${index + 1}. ${index === this.effortIndex ? this.theme.bold(choice.name) : choice.name}${currentLabel}${choice.description === undefined ? '' : `  ${this.theme.dim(choice.description)}`}`,
        width,
      ))
    }
    lines.push('', this.theme.dim('Press enter to confirm or esc to go back'))
    return lines
  }

  private move(offset: number): void {
    if (this.stage === 'model') {
      this.index = Math.max(0, Math.min(Math.max(0, this.rows.length - 1), this.index + offset))
      return
    }
    this.effortIndex = Math.max(0, Math.min(Math.max(0, this.currentEfforts().length - 1), this.effortIndex + offset))
  }

  private confirm(): void {
    const row = this.rows[this.index]
    if (row === undefined) return
    const choices = effortChoices(row)
    if (this.stage === 'model' && choices.length > 1) {
      const initial = row.providerId === this.models.current.provider && row.model.id === this.models.current.model
        ? this.models.current.reasoningEffort
        : row.model.reasoning?.defaultEffort
      this.effortIndex = Math.max(0, choices.findIndex(choice => choice.id === initial))
      this.stage = 'effort'
      return
    }
    const choice = choices[this.effortIndex] ?? choices[0]
    this.onSelect({
      provider: row.providerId,
      model: row.model.id,
      ...choice?.id === undefined ? {} : { reasoningEffort: choice.id },
    })
  }

  private currentEfforts(): EffortChoice[] {
    const row = this.rows[this.index]
    return row === undefined ? [] : effortChoices(row)
  }
}

/** Confirmation surface for the single file-restore plus conversation-fork rewind action. */
export class RewindDialog implements Component {
  private confirmSelected = true

  constructor(
    private readonly preview: RewindPreview,
    private readonly theme: TuiTheme,
    private readonly onConfirm: () => void,
    private readonly onCancel: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
      this.confirmSelected = true
      return
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.confirmSelected = false
      return
    }
    if (matchesKey(data, Key.enter)) {
      if (this.confirmSelected) this.onConfirm()
      else this.onCancel()
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const prompt = sanitizeTerminalText(this.preview.prompt).replaceAll('\n', ' ')
    const lines = [
      this.theme.bold('Rewind Last Turn'),
      this.theme.dim('Restore the workspace checkpoint and return to the previous user-message node.'),
      '',
      truncateToWidth(`${this.theme.bold('Prompt')}  ${prompt}`, width),
      this.theme.bold(`Checkpoint · ${this.preview.files.length} changed file${this.preview.files.length === 1 ? '' : 's'}`),
    ]
    if (this.preview.files.length === 0) lines.push(this.theme.dim('  No workspace files changed.'))
    for (const change of this.preview.files.slice(0, 8)) {
      const counts = change.added === undefined || change.removed === undefined
        ? 'binary'
        : `${this.theme.success(`+${change.added}`)} ${this.theme.error(`-${change.removed}`)}`
      lines.push(truncateToWidth(`  ${counts}  ${sanitizeTerminalText(change.path)}`, width))
    }
    if (this.preview.files.length > 8) {
      lines.push(this.theme.dim(`  … ${this.preview.files.length - 8} more files`))
    }
    const confirm = this.confirmSelected ? this.theme.hover(' Rewind ') : ' Rewind '
    const cancel = this.confirmSelected ? ' Cancel ' : this.theme.hover(' Cancel ')
    lines.push('', `${confirm}  ${cancel}`, this.theme.dim('←/→ choose · Enter confirm · Esc cancel'))
    return lines
  }
}

/** Multi-select question dialog: Space toggles and Enter submits. */
export class MultiSelectDialog implements Component {
  private index = 0
  private readonly selected = new Set<string>()

  constructor(
    private readonly title: string,
    private readonly items: SelectItem[],
    private readonly theme: TuiTheme,
    private readonly onSubmit: (selected: string[]) => void,
    private readonly onCustom: (selected: string[]) => void,
    private readonly onCancel: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.index = Math.max(0, this.index - 1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.index = Math.min(this.items.length, this.index + 1)
      return
    }
    if (matchesKey(data, Key.space)) {
      const item = this.items[this.index]
      if (item === undefined) {
        this.onCustom([...this.selected])
        return
      }
      if (this.selected.has(item.value)) this.selected.delete(item.value)
      else this.selected.add(item.value)
      return
    }
    if (matchesKey(data, Key.enter)) {
      if (this.index === this.items.length) {
        this.onCustom([...this.selected])
        return
      }
      if (this.selected.size === 0) {
        const item = this.items[this.index]
        if (item !== undefined) this.selected.add(item.value)
      }
      if (this.selected.size > 0) this.onSubmit([...this.selected])
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = [this.theme.bold(sanitizeTerminalText(this.title)), this.theme.dim('Space toggle · Enter confirm')]
    for (const [index, item] of this.items.entries()) {
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const checked = this.selected.has(item.value) ? this.theme.success('[x]') : '[ ]'
      lines.push(truncateToWidth(`${cursor} ${checked} ${sanitizeTerminalText(item.label)}`, width))
      if (item.description !== undefined) {
        lines.push(truncateToWidth(`      ${this.theme.dim(sanitizeTerminalText(item.description))}`, width))
      }
    }
    const customCursor = this.index === this.items.length ? this.theme.accent('›') : ' '
    lines.push(truncateToWidth(`${customCursor} [ ] Other…`, width))
    return lines
  }
}

/** One-line custom-answer overlay backed by pi-tui's IME-aware editor. */
export class TextInputDialog implements Component, Focusable {
  private readonly editor: Editor

  constructor(
    tui: TUI,
    private readonly title: string,
    private readonly theme: TuiTheme,
    onSubmit: (text: string) => void,
    private readonly onCancel: () => void,
  ) {
    this.editor = new Editor(tui, theme.editor, { paddingX: 0, autocompleteMaxVisible: 5 })
    this.editor.onSubmit = onSubmit
  }

  get focused(): boolean {
    return this.editor.focused
  }

  set focused(value: boolean) {
    this.editor.focused = value
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel()
      return
    }
    this.editor.handleInput(data)
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
