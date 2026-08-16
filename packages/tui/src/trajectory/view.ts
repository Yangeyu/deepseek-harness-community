import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type { TuiState } from '../runtime/controller.ts'
import { displayUnknown, sanitizeTerminalText } from '../text.ts'
import type { TuiTheme } from '../presentation/theme.ts'
import { TrajectoryModel, type TrajectoryMetrics } from './model.ts'
import {
  buildTrajectoryRecords,
  type TrajectoryKind,
  type TrajectoryRecord,
} from './records.ts'

type TrajectoryTab = 'summary' | 'payload' | 'result' | 'schema' | 'timing'

const TABS: ReadonlyArray<{ id: TrajectoryTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'payload', label: 'Input' },
  { id: 'result', label: 'Output' },
  { id: 'schema', label: 'Schema' },
  { id: 'timing', label: 'Timing' },
]

const SPLIT_MIN_WIDTH = 120
const SHARE_BAR_WIDTH = 7

function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(Math.max(0, Math.round(milliseconds)))} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  return `${String(minutes)}m ${String(seconds)}s`
}

function tabValue(record: TrajectoryRecord, tab: TrajectoryTab, metrics: TrajectoryMetrics): string[] {
  switch (tab) {
    case 'summary':
      return [
        `Status       ${record.status}`,
        `Duration     ${metrics.durationMs === undefined ? 'Not measured' : formatDuration(metrics.durationMs)}`,
        ...metrics.shareOfParent === undefined ? [] : [
          `Share        ${(metrics.shareOfParent * 100).toFixed(1)}% of ${metrics.parentTitle ?? 'parent'}`,
        ],
        ...metrics.slowest ? [`Bottleneck   Slowest timed block in ${metrics.parentTitle ?? 'current scope'}`] : [],
        `Location     ${[
          record.turn === undefined ? undefined : `Turn ${String(record.turn)}`,
          record.step === undefined ? undefined : `Step ${String(record.step)}`,
        ].filter(value => value !== undefined).join(' / ') || 'Session'}`,
        `Event        ${record.type}${record.completionType === undefined ? '' : ` → ${record.completionType}`}`,
        `Sequence     ${String(record.seq)}${record.completionSeq === undefined ? '' : ` → ${String(record.completionSeq)}`}`,
        '',
        record.title,
        ...(record.detail ?? record.summary).split('\n'),
        '',
        `Started      ${new Date(record.startedAt).toISOString()}`,
        `Completed    ${record.completedAt === undefined ? 'Still running or not applicable' : new Date(record.completedAt).toISOString()}`,
      ]
    case 'payload':
      return record.payload === undefined ? ['No payload recorded for this event.'] : displayUnknown(record.payload).split('\n')
    case 'result':
      return record.result === undefined ? ['No result recorded for this event.'] : displayUnknown(record.result).split('\n')
    case 'schema':
      return record.schema === undefined ? ['Schema unavailable for this event.'] : displayUnknown(record.schema).split('\n')
    case 'timing': {
      const end = record.completedAt
      return [
        `Started: ${new Date(record.startedAt).toISOString()}`,
        ...end === undefined ? ['Completed: still running or not applicable'] : [
          `Completed: ${new Date(end).toISOString()}`,
          `Duration: ${formatDuration(metrics.durationMs ?? Math.max(0, end - record.startedAt))}`,
        ],
        ...metrics.shareOfParent === undefined ? [] : [
          `Parent share: ${(metrics.shareOfParent * 100).toFixed(1)}% of ${metrics.parentTitle ?? 'parent'}`,
        ],
        `Start offset: +${formatDuration(metrics.offsetMs)}`,
        '',
        'Timing source: durable session event timestamps',
      ]
    }
  }
}

function wrapped(lines: readonly string[], width: number): string[] {
  return lines.flatMap(line => {
    const rendered = wrapTextWithAnsi(sanitizeTerminalText(line), Math.max(1, width))
    return rendered.length === 0 ? [''] : rendered
  })
}

function kindLabel(kind: TrajectoryKind): string {
  switch (kind) {
    case 'turn': return 'TURN'
    case 'step': return 'STEP'
    case 'user': return 'USER'
    case 'request': return 'REQUEST'
    case 'assistant': return 'ASSISTANT'
    case 'tool': return 'TOOL'
    case 'command': return 'COMMAND'
    case 'vision': return 'VISION'
    case 'context': return 'CONTEXT'
    case 'event': return 'EVENT'
  }
}

function padVisible(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), '…')
  return `${clipped}${' '.repeat(Math.max(0, width - visibleWidth(clipped)))}`
}

function compactDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '—'
  if (milliseconds < 1_000) return `${String(Math.round(milliseconds))}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`
}

/** Full-screen, keyboard-first execution ledger and event detail surface. */
export class TrajectoryView implements Component {
  private state: Readonly<TuiState>
  private records: TrajectoryRecord[]
  private model: TrajectoryModel<TrajectoryRecord>
  private index: number
  private mode: 'list' | 'detail' = 'list'
  private tabIndex = 0
  private detailOffset = 0
  private detailPageRows = 1
  private detailMaxOffset = 0
  private listPageRows = 1
  private followTail = true
  private loadingEarlier = false
  private loadError: string | undefined
  private splitLayout = false
  private readonly collapsedTurns = new Set<number>()
  private readonly collapsedSteps = new Set<string>()

  constructor(
    state: Readonly<TuiState>,
    private readonly visibleRows: () => number,
    private readonly theme: TuiTheme,
    private readonly onLoadEarlier: () => Promise<boolean>,
    private readonly onInterrupt: () => void,
    private readonly onCancel: () => void,
    private readonly onChange: () => void,
  ) {
    this.state = state
    this.records = buildTrajectoryRecords(state.events)
    this.model = new TrajectoryModel(this.records)
    this.index = Math.max(0, this.records.length - 1)
  }

  /** Rebuild from the latest live event window while preserving the selected semantic record. */
  setState(state: Readonly<TuiState>): void {
    const sessionChanged = state.sessionId !== this.state.sessionId
    const selectedKey = this.records[this.index]?.key
    this.state = state
    this.records = buildTrajectoryRecords(state.events)
    this.model = new TrajectoryModel(this.records)
    if (sessionChanged) {
      this.mode = 'list'
      this.followTail = true
      this.tabIndex = 0
      this.detailOffset = 0
      this.collapsedTurns.clear()
      this.collapsedSteps.clear()
    }
    const preserved = selectedKey === undefined
      ? -1
      : this.records.findIndex(record => record.key === selectedKey)
    this.index = this.followTail || preserved === -1
      ? Math.max(0, this.records.length - 1)
      : preserved
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      if (this.state.running) this.onInterrupt()
      else this.onCancel()
      return
    }
    if (this.mode === 'detail') {
      if (matchesKey(data, Key.escape)) {
        this.mode = 'list'
        this.detailOffset = 0
        return
      }
      if (matchesKey(data, Key.tab)) {
        this.selectTab(1)
        return
      }
      if (matchesKey(data, Key.shift(Key.tab))) {
        this.selectTab(-1)
        return
      }
      if (matchesKey(data, Key.left)) {
        this.selectTab(-1)
        return
      }
      if (matchesKey(data, Key.right)) {
        this.selectTab(1)
        return
      }
      if (matchesKey(data, Key.up) || data === 'k') this.scrollDetail(-1)
      if (matchesKey(data, Key.down) || data === 'j') this.scrollDetail(1)
      if (matchesKey(data, Key.pageUp)) this.scrollDetail(-this.detailPageRows)
      if (matchesKey(data, Key.pageDown)) this.scrollDetail(this.detailPageRows)
      return
    }
    if (matchesKey(data, Key.escape)) {
      this.onCancel()
      return
    }
    if (this.splitLayout && matchesKey(data, Key.tab) && this.records[this.index] !== undefined) {
      this.openDetail()
      return
    }
    if (data === 'h') {
      this.collapseSelected()
      return
    }
    if (data === 'l') {
      this.expandSelected()
      return
    }
    if (matchesKey(data, Key.up) || data === 'k') {
      if (this.index === 0) void this.loadEarlier()
      else this.move(-1)
      return
    }
    if (matchesKey(data, Key.down) || data === 'j') {
      this.move(1)
      return
    }
    if (matchesKey(data, Key.pageUp)) {
      const previous = this.index
      this.move(-this.listPageRows)
      if (previous === 0 || this.index === 0) void this.loadEarlier()
      return
    }
    if (matchesKey(data, Key.pageDown)) {
      this.move(this.listPageRows)
      return
    }
    if (data === 'g') {
      this.index = this.visibleRecordIndexes()[0] ?? 0
      this.followTail = false
      this.detailOffset = 0
      return
    }
    if (data === 'G') {
      this.index = this.visibleRecordIndexes().at(-1) ?? Math.max(0, this.records.length - 1)
      this.followTail = true
      this.detailOffset = 0
      return
    }
    if (matchesKey(data, Key.ctrl('u'))) {
      this.move(-Math.max(1, Math.floor(this.listPageRows / 2)))
      return
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      this.move(Math.max(1, Math.floor(this.listPageRows / 2)))
      return
    }
    if (matchesKey(data, Key.enter) && this.records[this.index] !== undefined) {
      this.openDetail()
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const now = Date.now()
    const { metrics, bottleneck } = this.model.measure(now)
    this.splitLayout = width >= SPLIT_MIN_WIDTH && this.records[this.index] !== undefined
    if (this.splitLayout) return this.renderSplit(width, metrics, bottleneck)
    return this.mode === 'detail'
      ? this.renderDetail(width, metrics)
      : this.renderList(width, metrics, bottleneck)
  }

  private renderList(
    width: number,
    metrics: ReadonlyMap<string, TrajectoryMetrics>,
    bottleneck: TrajectoryRecord | undefined,
  ): string[] {
    const height = Math.max(1, this.visibleRows())
    const header = this.renderOverviewHeader(width, metrics, bottleneck)
    const footerText = this.loadingEarlier
      ? 'Loading earlier history…'
      : this.loadError === undefined
        ? 'j/k select · h/l fold · Enter inspect · g/G ends · Esc chat'
        : `History load failed: ${this.loadError}`
    const footer = [truncateToWidth(
      this.loadError === undefined ? this.theme.dim(footerText) : this.theme.warning(footerText),
      width,
    )]
    const available = Math.max(0, height - header.length - footer.length - 1)
    const body = this.renderListRows(width, available, metrics)
    return this.fit([
      ...header,
      this.renderColumnHeader(width),
      ...body,
      ...Array<string>(Math.max(0, available - body.length)).fill(''),
      ...footer,
    ], height)
  }

  private renderSplit(
    width: number,
    metrics: ReadonlyMap<string, TrajectoryMetrics>,
    bottleneck: TrajectoryRecord | undefined,
  ): string[] {
    const height = Math.max(1, this.visibleRows())
    const header = this.renderOverviewHeader(width, metrics, bottleneck)
    const footerText = this.mode === 'detail'
      ? 'Detail focus · j/k scroll · Tab/←/→ section · Esc events'
      : 'Ledger focus · j/k select · h/l fold · Enter/Tab inspect · Esc chat'
    const footer = [truncateToWidth(this.theme.dim(footerText), width)]
    const available = Math.max(0, height - header.length - footer.length)
    const innerWidth = Math.max(1, width - 3)
    const leftWidth = Math.max(58, Math.min(innerWidth - 42, Math.floor(innerWidth * 0.58)))
    const rightWidth = Math.max(1, innerWidth - leftWidth)
    const record = this.records[this.index]
    if (record === undefined) return this.renderList(width, metrics, bottleneck)

    const leftBodyRows = Math.max(0, available - 1)
    const left = [
      this.renderColumnHeader(leftWidth),
      ...this.renderListRows(leftWidth, leftBodyRows, metrics),
    ]
    const right = this.renderDetailPanel(
      rightWidth,
      available,
      record,
      metrics.get(record.key) ?? { offsetMs: 0, slowest: false },
      true,
    )
    const divider = this.mode === 'detail' ? this.theme.accent('│') : this.theme.dim('│')
    const body = Array.from({ length: available }, (_, row) => {
      const leftLine = left[row] ?? ''
      const rightLine = right[row] ?? ''
      return `${padVisible(leftLine, leftWidth)} ${divider} ${truncateToWidth(rightLine, rightWidth, '…')}`
    })
    return this.fit([...header, ...body, ...footer], height)
  }

  private renderDetail(
    width: number,
    metrics: ReadonlyMap<string, TrajectoryMetrics>,
  ): string[] {
    const record = this.records[this.index]
    if (record === undefined) {
      this.mode = 'list'
      return this.renderList(width, metrics, undefined)
    }
    return this.renderDetailPanel(
      width,
      Math.max(1, this.visibleRows()),
      record,
      metrics.get(record.key) ?? { offsetMs: 0, slowest: false },
      false,
    )
  }

  private renderDetailPanel(
    width: number,
    height: number,
    record: TrajectoryRecord,
    metrics: TrajectoryMetrics,
    split: boolean,
  ): string[] {
    const tabs = TABS.map((tab, index) => index === this.tabIndex
      ? this.theme.bold(this.theme.accent(`[${tab.label}]`))
      : this.theme.dim(` ${tab.label} `)).join(' ')
    const location = [
      record.turn === undefined ? undefined : `Turn ${String(record.turn)}`,
      record.step === undefined ? undefined : `Step ${String(record.step)}`,
      `seq ${String(record.seq)}`,
    ].filter(value => value !== undefined).join(' · ')
    const header = split ? [
      truncateToWidth(this.theme.bold(this.theme.accent(`DETAIL · ${record.title}`)), width),
      truncateToWidth(this.theme.dim(`${kindLabel(record.kind)} · ${location}`), width),
      truncateToWidth(tabs, width),
      this.theme.dim('─'.repeat(Math.max(0, width))),
    ] : [
      truncateToWidth(this.theme.bold(this.theme.accent(`Trajectory · ${record.title}`)), width),
      truncateToWidth(this.theme.dim(`${kindLabel(record.kind)} · ${location}`), width),
      truncateToWidth(tabs, width),
      '',
    ]
    const available = Math.max(0, height - header.length - 1)
    this.detailPageRows = Math.max(1, available)
    const tab = TABS[this.tabIndex]?.id ?? 'summary'
    const content = wrapped(tabValue(record, tab, metrics), width)
    this.detailMaxOffset = Math.max(0, content.length - available)
    this.detailOffset = Math.max(0, Math.min(this.detailMaxOffset, this.detailOffset))
    const body = content.slice(this.detailOffset, this.detailOffset + available)
    const range = content.length <= available
      ? ''
      : ` · ${String(this.detailOffset + 1)}-${String(Math.min(content.length, this.detailOffset + available))}/${String(content.length)}`
    const controls = split && this.mode === 'list'
      ? 'Enter/Tab focus details'
      : 'Tab/←/→ section · j/k scroll · Esc events'
    const footer = [truncateToWidth(this.theme.dim(
      `${controls}${range}`,
    ), width)]
    return this.fit([...header, ...body, ...Array<string>(Math.max(0, available - body.length)).fill(''), ...footer], height)
  }

  private renderOverviewHeader(
    width: number,
    metrics: ReadonlyMap<string, TrajectoryMetrics>,
    bottleneck: TrajectoryRecord | undefined,
  ): string[] {
    const activeTurn = this.records.filter(record => record.kind === 'turn').at(-1)
    const total = activeTurn === undefined ? undefined : metrics.get(activeTurn.key)?.durationMs
    const visibleCount = this.visibleRecordIndexes().length
    const recordCount = visibleCount === this.records.length
      ? `${String(this.records.length)} records`
      : `${String(visibleCount)}/${String(this.records.length)} visible`
    const title = [
      'Trajectory',
      this.state.running ? 'Live' : 'Idle',
      activeTurn?.title,
      total === undefined ? undefined : formatDuration(total),
      recordCount,
    ].filter(value => value !== undefined).join(' · ')
    const bottleneckMetrics = bottleneck === undefined ? undefined : metrics.get(bottleneck.key)
    const bottleneckLine = bottleneck === undefined || bottleneckMetrics?.durationMs === undefined
      ? 'Bottleneck · no timed operation available yet'
      : `Bottleneck · ${bottleneck.title} · ${formatDuration(bottleneckMetrics.durationMs)}${
        bottleneckMetrics.shareOfParent === undefined
          ? ''
          : ` · ${(bottleneckMetrics.shareOfParent * 100).toFixed(1)}% of ${bottleneckMetrics.parentTitle ?? 'parent'}`
      }`
    return [
      truncateToWidth(this.theme.bold(this.theme.accent(title)), width),
      truncateToWidth(bottleneck === undefined ? this.theme.dim(bottleneckLine) : this.theme.warning(bottleneckLine), width),
      this.theme.dim('─'.repeat(Math.max(0, width))),
    ]
  }

  private renderColumnHeader(width: number): string {
    if (width < 44) return this.theme.dim(truncateToWidth('EXECUTION', width))
    const detailed = width >= 72
    const suffix = detailed
      ? `${padVisible('START', 7)} ${padVisible('TIME', 8)} ${padVisible('SHARE', SHARE_BAR_WIDTH)}`
      : padVisible('TIME', 8)
    const executionWidth = Math.max(1, width - visibleWidth(suffix) - 1)
    return this.theme.dim(`${padVisible('EXECUTION', executionWidth)} ${suffix}`)
  }

  private renderListRows(
    width: number,
    available: number,
    metrics: ReadonlyMap<string, TrajectoryMetrics>,
  ): string[] {
    this.listPageRows = Math.max(1, available)
    const visibleIndexes = this.visibleRecordIndexes()
    const selectedPosition = Math.max(0, visibleIndexes.indexOf(this.index))
    const maximumStart = Math.max(0, visibleIndexes.length - available)
    const start = Math.max(0, Math.min(maximumStart, selectedPosition - Math.floor(available / 2)))
    const visible = visibleIndexes.slice(start, start + available)
    if (visible.length === 0 && available > 0) {
      return [this.theme.dim('No execution records yet. Events will appear here while the session runs.')]
    }
    return visible.map(recordIndex => this.renderRecord(
      this.records[recordIndex] as TrajectoryRecord,
      recordIndex === this.index,
      width,
      metrics.get((this.records[recordIndex] as TrajectoryRecord).key) ?? {
        offsetMs: 0,
        slowest: false,
      },
    ))
  }

  private renderRecord(
    record: TrajectoryRecord,
    selected: boolean,
    width: number,
    metrics: TrajectoryMetrics,
  ): string {
    if (width < 28) {
      return truncateToWidth(`${selected ? '›' : ' '} ${kindLabel(record.kind)} ${record.title}`, width, '…')
    }
    const branch = record.kind === 'turn'
      ? ''
      : record.kind === 'step'
        ? '  ├─'
        : record.step === undefined
          ? '  ├─'
          : '  │ ├─'
    const glyph = record.status === 'pending'
      ? this.theme.warning('○')
      : record.status === 'warning'
        ? this.theme.warning('!')
      : record.status === 'failed'
        ? this.theme.error('×')
        : record.status === 'completed'
          ? this.theme.success('●')
          : this.theme.dim('·')
    const turnCollapsed = record.turn !== undefined && this.collapsedTurns.has(record.turn)
    const stepCollapsed = record.turn !== undefined
      && record.step !== undefined
      && this.collapsedSteps.has(stepKey(record.turn, record.step))
    const disclosure = record.kind === 'turn'
      ? turnCollapsed ? '▸ ' : '▾ '
      : record.kind === 'step'
        ? stepCollapsed ? '▸ ' : '▾ '
        : ''
    const cursor = selected ? this.theme.accent('›') : ' '
    const compact = width < 48
    const label = compact ? kindLabel(record.kind).slice(0, 4).padEnd(4) : kindLabel(record.kind).padEnd(9)
    const prefix = `${cursor} ${compact ? '' : branch}${disclosure}${glyph} ${label} `
    const durationLabel = padVisible(compactDuration(metrics.durationMs).padStart(7), 7)
    const durationCell = metrics.slowest
      ? this.theme.warning(`▲${durationLabel}`)
      : ` ${durationLabel}`
    const detailed = width >= 72
    const filled = metrics.shareOfParent === undefined
      ? 0
      : Math.max(1, Math.min(SHARE_BAR_WIDTH, Math.round(metrics.shareOfParent * SHARE_BAR_WIDTH)))
    const rawBar = metrics.shareOfParent === undefined
      ? '·'.repeat(SHARE_BAR_WIDTH)
      : `${'█'.repeat(filled)}${'·'.repeat(SHARE_BAR_WIDTH - filled)}`
    const bar = metrics.slowest ? this.theme.warning(rawBar) : this.theme.dim(rawBar)
    const offsetCell = padVisible(`+${compactDuration(metrics.offsetMs)}`, 7)
    const suffix = detailed ? `${offsetCell} ${durationCell} ${bar}` : durationCell
    const contentWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix) - 1)
    const content = padVisible(`${record.title} · ${record.summary}`, contentWidth)
    const line = `${prefix}${content} ${suffix}`
    return truncateToWidth(selected ? this.theme.bold(line) : line, width, '…')
  }

  private visibleRecordIndexes(): number[] {
    const indexes: number[] = []
    for (const [index, record] of this.records.entries()) {
      if (record.kind === 'turn') {
        indexes.push(index)
        continue
      }
      if (record.turn !== undefined && this.collapsedTurns.has(record.turn)) continue
      if (record.kind === 'step') {
        indexes.push(index)
        continue
      }
      if (record.turn !== undefined
        && record.step !== undefined
        && this.collapsedSteps.has(stepKey(record.turn, record.step))) continue
      indexes.push(index)
    }
    return indexes
  }

  private collapseSelected(): void {
    const record = this.records[this.index]
    if (record?.kind === 'turn' && record.turn !== undefined) {
      this.collapsedTurns.add(record.turn)
    } else if (record?.kind === 'step' && record.turn !== undefined && record.step !== undefined) {
      this.collapsedSteps.add(stepKey(record.turn, record.step))
    } else if (record !== undefined) {
      const parent = this.model.parentOf(record)
      const parentIndex = parent === undefined ? -1 : this.records.findIndex(candidate => candidate.key === parent.key)
      if (parentIndex >= 0) this.index = parentIndex
    }
    this.followTail = false
    this.detailOffset = 0
  }

  private expandSelected(): void {
    const record = this.records[this.index]
    if (record?.kind === 'turn' && record.turn !== undefined) {
      this.collapsedTurns.delete(record.turn)
    } else if (record?.kind === 'step' && record.turn !== undefined && record.step !== undefined) {
      this.collapsedSteps.delete(stepKey(record.turn, record.step))
    }
    this.detailOffset = 0
  }

  private move(offset: number): void {
    const visible = this.visibleRecordIndexes()
    const position = Math.max(0, visible.indexOf(this.index))
    const target = Math.max(0, Math.min(visible.length - 1, position + offset))
    this.index = visible[target] ?? this.index
    this.followTail = this.index === this.records.length - 1
    this.detailOffset = 0
  }

  private openDetail(): void {
    this.mode = 'detail'
    this.followTail = false
    this.tabIndex = 0
    this.detailOffset = 0
  }

  private selectTab(offset: number): void {
    this.tabIndex = (this.tabIndex + offset + TABS.length) % TABS.length
    this.detailOffset = 0
  }

  private scrollDetail(offset: number): void {
    this.detailOffset = Math.max(0, Math.min(this.detailMaxOffset, this.detailOffset + offset))
  }

  private async loadEarlier(): Promise<void> {
    if (!this.state.historyHasMore || this.loadingEarlier) return
    this.loadingEarlier = true
    this.loadError = undefined
    this.followTail = false
    this.onChange()
    try {
      await this.onLoadEarlier()
    } catch (error: unknown) {
      this.loadError = error instanceof Error ? error.message : String(error)
    } finally {
      this.loadingEarlier = false
      this.onChange()
    }
  }

  private fit(lines: string[], height: number): string[] {
    return [
      ...lines.slice(0, height),
      ...Array<string>(Math.max(0, height - lines.length)).fill(''),
    ]
  }
}
