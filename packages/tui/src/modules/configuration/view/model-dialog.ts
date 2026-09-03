import { truncateToWidth } from '@earendil-works/pi-tui'
import type {
  ModelReasoningEffort,
  ModelSelection,
  SessionModels,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiTheme } from '../../../presentation/primitives/theme.ts'
import type {
  SurfaceInputAction,
  SurfaceInputTarget,
} from '../../../presentation/primitives/surface-input.ts'

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

function visibleRange(total: number, selected: number, pageRows: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(total, pageRows))
  const start = Math.max(0, Math.min(total - size, selected - size + 1))
  return { start, end: Math.min(total, start + size) }
}

/** Two-stage model and reasoning-effort selector with bounded viewport paging. */
export class ModelDialog implements SurfaceInputTarget {
  readonly inputContext = 'model-menu' as const
  private readonly rows: ModelRow[]
  private index: number
  private stage: 'model' | 'effort' = 'model'
  private effortIndex = 0

  constructor(
    private readonly models: SessionModels,
    private readonly visibleRows: () => number,
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

  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.previous') return this.move(-1)
    if (action === 'surface.next') return this.move(1)
    if (action === 'surface.page-previous') return this.move(-this.pageRows())
    if (action === 'surface.page-next') return this.move(this.pageRows())
    if (action.startsWith('surface.select-')) {
      const selected = Number(action.slice('surface.select-'.length)) - 1
      if (this.stage === 'model') {
        if (selected < this.rows.length) this.index = selected
      } else if (selected < this.currentEfforts().length) this.effortIndex = selected
      return
    }
    if (action === 'surface.confirm') return this.confirm()
    if (action === 'surface.back' || action === 'surface.cancel') {
      if (this.stage === 'effort') this.stage = 'model'
      else this.onCancel()
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.stage === 'model' ? this.renderModels(width) : this.renderEfforts(width)
  }

  private renderModels(width: number): string[] {
    const failureRows = this.models.failures.length === 0 ? 0 : 1
    const range = visibleRange(this.rows.length, this.index, Math.max(1, this.visibleRows() - 5 - failureRows))
    const lines = [
      this.theme.bold('Select Model and Effort'),
      this.theme.dim('Choose a model. The selection also becomes the default for new sessions.'),
      '',
    ]
    if (this.rows.length === 0) lines.push(this.theme.warning('No models are currently available.'))
    for (let index = range.start; index < range.end; index += 1) {
      const row = this.rows[index]!
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const current = row.providerId === this.models.current.provider && row.model.id === this.models.current.model
      const currentLabel = current ? this.theme.dim(' (current)') : ''
      const description = row.model.description ?? row.providerName
      lines.push(truncateToWidth(
        `${cursor} ${index + 1}. ${index === this.index ? this.theme.bold(row.model.name) : row.model.name}${currentLabel}${description === '' ? '' : `  ${this.theme.dim(description)}`}`,
        width,
      ))
    }
    const failure = this.models.failures[0]
    if (failure !== undefined) {
      const more = this.models.failures.length === 1 ? '' : ` (+${String(this.models.failures.length - 1)} more)`
      lines.push(truncateToWidth(this.theme.warning(`${failure.name}: ${failure.message}${more}`), width))
    }
    const position = this.rows.length <= range.end - range.start
      ? ''
      : ` · ${String(range.start + 1)}-${String(range.end)}/${String(this.rows.length)}`
    lines.push('', this.theme.dim(`↑/↓ select · PageUp/PageDown page · Enter continue · Esc back${position}`))
    return lines
  }

  private renderEfforts(width: number): string[] {
    const row = this.rows[this.index]
    const choices = this.currentEfforts()
    const range = visibleRange(choices.length, this.effortIndex, Math.max(1, this.visibleRows() - 5))
    const lines = [
      this.theme.bold('Select Reasoning Effort'),
      this.theme.dim(row?.model.name ?? ''),
      '',
    ]
    for (let index = range.start; index < range.end; index += 1) {
      const choice = choices[index]!
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
    const position = choices.length <= range.end - range.start
      ? ''
      : ` · ${String(range.start + 1)}-${String(range.end)}/${String(choices.length)}`
    lines.push('', this.theme.dim(`↑/↓ select · PageUp/PageDown page · Enter confirm · Esc back${position}`))
    return lines
  }

  private pageRows(): number {
    return Math.max(1, this.visibleRows() - 6)
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
