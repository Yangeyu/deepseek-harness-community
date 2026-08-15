import {
  Editor,
  Key,
  SelectList,
  Text,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
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
import type {
  MemoryDocument,
  MemoryOverview,
  MemorySessionPolicy,
} from '@vascent/deepseek-harness-memory'
import { sanitizeTerminalText } from './text.ts'
import type { TuiTheme } from './theme.ts'
import type { RewindCheckpointSummary, RewindPreview } from './checkpoint.ts'

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

/** Composer-anchored memory policy and Markdown document browser. */
export class MemoryDialog implements Component {
  private index = 0
  private document: MemoryDocument | undefined
  private documentOffset = 0
  private policy: MemorySessionPolicy
  private readonly documents: MemoryDocument[]

  constructor(
    private readonly overview: MemoryOverview,
    private readonly visibleRows: () => number,
    private readonly theme: TuiTheme,
    private readonly onPolicy: (policy: MemorySessionPolicy) => void,
    private readonly onCancel: () => void,
  ) {
    this.policy = overview.policy
    const byPath = new Map<string, MemoryDocument>()
    for (const document of [overview.projectMemory, overview.global, ...overview.documents]) {
      byPath.set(document.path, document)
    }
    this.documents = [...byPath.values()]
  }

  handleInput(data: string): void {
    if (this.document !== undefined) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
        this.document = undefined
        this.documentOffset = 0
        return
      }
      const page = this.documentPageRows()
      if (matchesKey(data, Key.up)) this.moveDocument(-1)
      if (matchesKey(data, Key.down)) this.moveDocument(1)
      if (matchesKey(data, Key.pageUp)) this.moveDocument(-page)
      if (matchesKey(data, Key.pageDown)) this.moveDocument(page)
      return
    }
    if (matchesKey(data, Key.up)) {
      this.index = Math.max(0, this.index - 1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.index = Math.min(this.documents.length + 1, this.index + 1)
      return
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      if (this.index === 0) {
        this.policy = { ...this.policy, useMemories: !this.policy.useMemories }
        this.onPolicy(this.policy)
        return
      }
      if (this.index === 1) {
        this.policy = { ...this.policy, generateMemories: !this.policy.generateMemories }
        this.onPolicy(this.policy)
        return
      }
      this.document = this.documents[this.index - 2]
      this.documentOffset = 0
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.document === undefined ? this.renderList(width) : this.renderDocument(width, this.document)
  }

  private renderList(width: number): string[] {
    const lines = [
      this.theme.bold('Memories'),
      this.theme.dim(`Project · ${this.overview.project.id}`),
      '',
      this.toggleLine(0, 'Use memories in this session', this.policy.useMemories),
      this.toggleLine(1, 'Learn from this session', this.policy.generateMemories),
      '',
    ]
    for (const [offset, document] of this.documents.entries()) {
      const index = offset + 2
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const label = document.scope === 'project'
        ? document.topic === undefined ? 'Project memory' : `Project · ${document.topic}`
        : document.topic === undefined ? 'Global memory' : `Global · ${document.topic}`
      const status = document.exists ? `${document.bytes} bytes` : 'not created'
      lines.push(truncateToWidth(
        `${cursor} ${index === this.index ? this.theme.bold(label) : label}  ${this.theme.dim(status)}`,
        width,
      ))
    }
    lines.push('', this.theme.dim('↑/↓ select · Enter toggle/open · Esc close'))
    return lines
  }

  private renderDocument(width: number, document: MemoryDocument): string[] {
    const body = document.exists && document.content.trim() !== ''
      ? sanitizeTerminalText(document.content).split('\n')
      : ['(empty memory document)']
    const page = this.documentPageRows()
    const maximum = Math.max(0, body.length - page)
    this.documentOffset = Math.max(0, Math.min(maximum, this.documentOffset))
    const visible = body.slice(this.documentOffset, this.documentOffset + page)
    const range = body.length <= page
      ? ''
      : ` · ${this.documentOffset + 1}-${Math.min(body.length, this.documentOffset + page)}/${body.length}`
    return [
      this.theme.bold(document.scope === 'project' ? 'Project memory' : 'Global memory'),
      truncateToWidth(this.theme.dim(document.path), width),
      '',
      ...visible.flatMap(line => wrapTextWithAnsi(line, width)),
      '',
      this.theme.dim(`↑/↓ scroll · PageUp/PageDown page · Esc back${range}`),
    ]
  }

  private toggleLine(index: number, label: string, enabled: boolean): string {
    const cursor = this.index === index ? this.theme.accent('›') : ' '
    const name = this.index === index ? this.theme.bold(label) : label
    return `${cursor} ${name}  ${enabled ? this.theme.success('on') : this.theme.dim('off')}`
  }

  private moveDocument(offset: number): void {
    const lines = this.document?.content.split('\n').length ?? 1
    this.documentOffset = Math.max(0, Math.min(Math.max(0, lines - this.documentPageRows()), this.documentOffset + offset))
  }

  private documentPageRows(): number {
    return Math.max(3, this.visibleRows() - 8)
  }
}

/** Bounded keyboard selector for process-local turn checkpoints. */
export class RewindCheckpointDialog implements Component {
  private summaries: RewindCheckpointSummary[]
  private index: number
  private inspectionError: string | undefined

  constructor(
    summaries: RewindCheckpointSummary[],
    selectedCheckpointId: string | undefined,
    private readonly visibleRows: () => number,
    private readonly theme: TuiTheme,
    private readonly onSelect: (summary: RewindCheckpointSummary) => void,
    private readonly onCancel: () => void,
  ) {
    this.summaries = summaries
    const selected = selectedCheckpointId === undefined
      ? summaries.length - 1
      : summaries.findIndex(summary => summary.checkpointId === selectedCheckpointId)
    this.index = Math.max(0, selected)
  }

  /** Replace asynchronously inspected rows without moving the current selection. */
  setSummaries(summaries: RewindCheckpointSummary[]): void {
    const selectedId = this.summaries[this.index]?.checkpointId
    this.summaries = summaries
    const selected = selectedId === undefined
      ? summaries.length - 1
      : summaries.findIndex(summary => summary.checkpointId === selectedId)
    this.index = selected === -1 ? Math.max(0, summaries.length - 1) : Math.max(0, selected)
    this.inspectionError = undefined
  }

  /** Keep selection usable when optional workspace-count inspection fails. */
  setInspectionError(message: string): void {
    this.inspectionError = message
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
    if (matchesKey(data, Key.pageUp)) {
      this.move(-this.maxVisibleItems())
      return
    }
    if (matchesKey(data, Key.pageDown)) {
      this.move(this.maxVisibleItems())
      return
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.summaries[this.index]
      if (selected !== undefined) this.onSelect(selected)
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const maxVisible = this.maxVisibleItems()
    const start = Math.max(0, Math.min(
      this.summaries.length - maxVisible,
      this.index - Math.floor(maxVisible / 2),
    ))
    const end = Math.min(this.summaries.length, start + maxVisible)
    const lines = [
      this.theme.bold('Rewind'),
      this.theme.dim('Restore the workspace and conversation to the point before…'),
      '',
    ]
    if (start > 0) lines.push(this.theme.dim(`  ↑ ${start} more above`), '')
    for (let row = start; row < end; row += 1) {
      const summary = this.summaries[row]
      if (summary === undefined) continue
      const selected = row === this.index
      const cursor = selected ? this.theme.accent('›') : ' '
      const prompt = sanitizeTerminalText(summary.prompt).replaceAll('\n', ' ')
      const fileStatus = summary.turnChangedFiles === undefined
        ? 'Checking workspace changes…'
        : summary.turnChangedFiles === 0
          ? 'No code changes'
          : `${summary.turnChangedFiles} changed file${summary.turnChangedFiles === 1 ? '' : 's'} this turn`
      const memoryStatus = (summary.memoryUpdates ?? 0) === 0
        ? ''
        : ` · ${summary.memoryUpdates} memory update${summary.memoryUpdates === 1 ? '' : 's'}`
      lines.push(truncateToWidth(
        `${cursor} ${selected ? this.theme.bold(prompt) : prompt}`,
        width,
      ))
      lines.push(truncateToWidth(`    ${this.theme.dim(`${fileStatus}${memoryStatus}`)}`, width), '')
    }
    if (end < this.summaries.length) lines.push(this.theme.dim(`  ↓ ${this.summaries.length - end} more below`), '')
    if (this.inspectionError !== undefined) {
      lines.push(truncateToWidth(this.theme.warning(`Workspace status unavailable: ${this.inspectionError}`), width))
    }
    lines.push(this.theme.dim('↑/↓ select · Enter continue · Esc cancel'))
    return lines
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(this.summaries.length - 1, this.index + offset))
  }

  private maxVisibleItems(): number {
    return Math.max(1, Math.min(6, Math.floor((this.visibleRows() - 8) / 3)))
  }
}

function relativeAge(time: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Claude Code-style confirmation for the unified workspace and conversation rewind. */
export class RewindDialog implements Component {
  private selected = 0

  constructor(
    private readonly preview: RewindPreview,
    private readonly theme: TuiTheme,
    private readonly onConfirm: () => void,
    private readonly onCancel: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selected = 0
      return
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.selected = 1
      return
    }
    if (data === '1' || data === '2') {
      this.selected = Number(data) - 1
      return
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selected === 0) this.onConfirm()
      else this.onCancel()
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const prompt = sanitizeTerminalText(this.preview.prompt).replaceAll('\n', ' ')
    const changed = this.preview.files.length
    const memoryUpdates = this.preview.memoryMutations?.length ?? 0
    const confirmation = wrapTextWithAnsi(
      this.theme.dim('Confirm you want to restore the workspace, memory, and conversation to the point before you sent this message:'),
      width,
    )
    const promptLines = wrapTextWithAnsi(prompt, Math.max(1, width - 2))
    const impact = wrapTextWithAnsi(this.theme.dim(changed === 0
      ? 'The code will be unchanged.'
      : `${changed} changed file${changed === 1 ? '' : 's'} will be restored.`), width)
    const memoryImpact = memoryUpdates === 0
      ? []
      : wrapTextWithAnsi(this.theme.dim(`${memoryUpdates} memory update${memoryUpdates === 1 ? '' : 's'} will be reverted.`), width)
    const lines = [
      this.theme.bold('Rewind'),
      '',
      ...confirmation,
      '',
      ...promptLines.map(line => `${this.theme.dim('│')} ${this.theme.bold(line)}`),
      `${this.theme.dim('│')} ${this.theme.dim(`(${relativeAge(this.preview.createdAt)})`)}`,
      '',
      this.theme.dim('The conversation will be forked.'),
      ...impact,
      ...memoryImpact,
      '',
    ]
    const restore = `${this.selected === 0 ? '›' : ' '} 1. Restore workspace, memory, and conversation`
    const cancel = `${this.selected === 1 ? '›' : ' '} 2. Never mind`
    lines.push(
      this.selected === 0 ? this.theme.accent(restore) : restore,
      this.selected === 1 ? this.theme.accent(cancel) : cancel,
      '',
      this.theme.dim('↑/↓ select · Enter confirm · Esc back'),
    )
    return lines.map(line => truncateToWidth(line, width))
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
