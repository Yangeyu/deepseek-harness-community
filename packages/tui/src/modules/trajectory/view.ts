import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import { displayUnknown, sanitizeTerminalText } from '../../presentation/primitives/text.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { TrajectoryModel, type TrajectoryMetrics } from './model.ts'
import {
  buildTrajectoryRecords,
  trajectoryParentKey,
  trajectoryTiming,
  type TrajectoryKind,
  type TrajectoryRecord,
} from './records.ts'
import { appendedHistoryEntries } from '../../runtime/session/event-window.ts'
import { formatDuration } from '../../presentation/primitives/duration.ts'
import { statusVisual } from '../../presentation/primitives/status-visual.ts'
import { executionStatus } from '../../runtime/execution/projection/index.ts'
import type {
  SurfaceInputAction,
  SurfaceInputTarget,
  SurfacePointerAction,
  SurfacePointerTarget,
} from '../../presentation/primitives/surface-input.ts'

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

interface TrajectoryRecordPresentation {
  readonly heading: string
  readonly ledger: string
  readonly summary: readonly string[]
}

type TrajectoryClickTarget =
  | { readonly kind: 'record'; readonly index: number }
  | { readonly kind: 'tab'; readonly index: number }

interface TrajectoryClickHit {
  readonly row: number
  readonly columnStart: number
  readonly columnEnd: number
  readonly target: TrajectoryClickTarget
}

/** Keep record identity ordering consistent across the ledger and detail pane. */
function recordPresentation(record: TrajectoryRecord): TrajectoryRecordPresentation {
  const description = (record.detail ?? record.summary).split('\n')
  if (record.toolName === undefined) {
    return {
      heading: record.title,
      ledger: `${record.title} · ${record.summary}`,
      summary: [record.title, ...description],
    }
  }
  const operation = (record.detail ?? record.title).split('\n')
  const operationDiffers = operation.length > 1 || operation[0] !== record.toolName
  return {
    heading: operationDiffers ? `${record.toolName} · ${operation[0] ?? record.title}` : record.toolName,
    ledger: `${record.toolName} · ${record.summary}`,
    summary: [
      `Tool         ${record.toolName}`,
      ...operationDiffers ? [
        `Operation    ${operation[0] ?? record.title}`,
        ...operation.slice(1).map(line => `             ${line}`),
      ] : [],
    ],
  }
}

function tabValue(record: TrajectoryRecord, tab: TrajectoryTab, metrics: TrajectoryMetrics): string[] {
  const timing = trajectoryTiming(record)
  switch (tab) {
    case 'summary': {
      const presentation = recordPresentation(record)
      return [
        `Status       ${timing.status}`,
        `Duration     ${metrics.durationMs === undefined ? 'Not measured' : formatDuration(metrics.durationMs, 'detail')}`,
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
        ...presentation.summary,
        '',
        `Started      ${timing.startedAt === undefined ? 'Not recorded' : new Date(timing.startedAt).toISOString()}`,
        `Completed    ${timing.completedAt === undefined ? 'Still running or not applicable' : new Date(timing.completedAt).toISOString()}`,
      ]
    }
    case 'payload':
      return record.payload === undefined ? ['No payload recorded for this event.'] : displayUnknown(record.payload).split('\n')
    case 'result':
      return record.result === undefined ? ['No result recorded for this event.'] : displayUnknown(record.result).split('\n')
    case 'schema':
      return record.schema === undefined ? ['Schema unavailable for this event.'] : displayUnknown(record.schema).split('\n')
    case 'timing': {
      const end = timing.completedAt
      return [
        `Started: ${timing.startedAt === undefined ? 'not recorded' : new Date(timing.startedAt).toISOString()}`,
        ...end === undefined ? ['Completed: still running or not applicable'] : [
          `Completed: ${new Date(end).toISOString()}`,
          `Duration: ${metrics.durationMs === undefined ? 'not measured' : formatDuration(metrics.durationMs, 'detail')}`,
        ],
        ...metrics.shareOfParent === undefined ? [] : [
          `Parent share: ${(metrics.shareOfParent * 100).toFixed(1)}% of ${metrics.parentTitle ?? 'parent'}`,
        ],
        `Start offset: +${formatDuration(metrics.offsetMs, 'detail')}`,
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

function paintLedgerRow(text: string, selected: boolean, width: number, theme: TuiTheme): string {
  const row = padVisible(text, width)
  return selected ? theme.focusRow(theme.bold(row)) : row
}

function compactDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '—'
  return formatDuration(milliseconds, 'compact')
}

function recordGlyph(record: TrajectoryRecord, theme: TuiTheme): string {
  if (!('execution' in record)) return record.tone === 'warning' ? theme.warning('!') : theme.dim('·')
  const visual = statusVisual(executionStatus(record.execution), theme)
  const painted = visual.paint(visual.glyph)
  return visual.bold ? theme.bold(painted) : painted
}

/** Full-screen, keyboard-first execution ledger and event detail surface. */
export class TrajectoryView implements SurfaceInputTarget, SurfacePointerTarget {
  readonly inputContext = 'trajectory' as const
  private state: Readonly<RuntimeSessionSnapshot>
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
  private executionColumnEnd = 0
  private detailColumnStart: number | undefined
  private readonly clickHits: TrajectoryClickHit[] = []
  private readonly collapsedTurns = new Set<number>()
  private readonly collapsedSteps = new Set<string>()

  constructor(
    state: Readonly<RuntimeSessionSnapshot>,
    private readonly visibleRows: () => number,
    private readonly theme: TuiTheme,
    private readonly onLoadEarlier: () => Promise<boolean>,
    private readonly onInterrupt: () => void,
    private readonly onCancel: () => void,
    private readonly onChange: () => void,
  ) {
    this.state = state
    this.records = buildTrajectoryRecords(state.events, state.execution)
    this.model = new TrajectoryModel(this.records, trajectoryTiming, trajectoryParentKey)
    this.index = Math.max(0, this.records.length - 1)
  }

  get snapshot(): {
    readonly mode: 'list' | 'detail'
    readonly selectedKey: string | undefined
    readonly records: number
    readonly following: boolean
  } {
    return {
      mode: this.mode,
      selectedKey: this.records[this.index]?.key,
      records: this.records.length,
      following: this.followTail,
    }
  }

  /** Rebuild from the latest live event window while preserving the selected semantic record. */
  setState(state: Readonly<RuntimeSessionSnapshot>): void {
    const sessionChanged = state.sessionId !== this.state.sessionId
    const appended = sessionChanged
      ? undefined
      : appendedHistoryEntries(this.state.events, state.events)
    if (!sessionChanged
      && state.execution === this.state.execution
      && appended !== undefined
      && appended.every(entry => entry.event.type === 'assistant/chunk')) {
      this.state = state
      return
    }
    const selectedKey = this.records[this.index]?.key
    this.state = state
    this.records = buildTrajectoryRecords(state.events, state.execution)
    this.model = new TrajectoryModel(this.records, trajectoryTiming, trajectoryParentKey)
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

  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.interrupt-or-cancel') {
      if (this.state.runState !== 'idle') this.onInterrupt()
      else this.onCancel()
      return
    }
    if (this.mode === 'detail') {
      if (action === 'surface.back' || action === 'surface.cancel') {
        this.mode = 'list'
        this.detailOffset = 0
        return
      }
      if (action === 'surface.tab-next') {
        this.selectTab(1)
        return
      }
      if (action === 'surface.tab-previous') {
        this.selectTab(-1)
        return
      }
      if (action === 'surface.previous' || action === 'surface.detail-previous') this.scrollDetail(-1)
      if (action === 'surface.next' || action === 'surface.detail-next') this.scrollDetail(1)
      if (action === 'surface.page-previous') this.scrollDetail(-this.detailPageRows)
      if (action === 'surface.page-next') this.scrollDetail(this.detailPageRows)
      return
    }
    if (action === 'surface.back' || action === 'surface.cancel') {
      this.onCancel()
      return
    }
    if (this.splitLayout && action === 'surface.tab-next' && this.records[this.index] !== undefined) {
      this.openDetail()
      return
    }
    if (action === 'surface.collapse') {
      this.collapseSelected()
      return
    }
    if (action === 'surface.expand') {
      this.expandSelected()
      return
    }
    if (action === 'surface.previous') {
      if (this.index === 0) void this.loadEarlier()
      else this.move(-1)
      return
    }
    if (action === 'surface.next') {
      this.move(1)
      return
    }
    if (this.splitLayout && action === 'surface.detail-previous') {
      this.scrollDetail(-1)
      return
    }
    if (this.splitLayout && action === 'surface.detail-next') {
      this.scrollDetail(1)
      return
    }
    if (action === 'surface.page-previous') {
      const previous = this.index
      this.move(-this.listPageRows)
      if (previous === 0 || this.index === 0) void this.loadEarlier()
      return
    }
    if (action === 'surface.page-next') {
      this.move(this.listPageRows)
      return
    }
    if (action === 'surface.first') {
      this.index = this.visibleRecordIndexes()[0] ?? 0
      this.followTail = false
      this.detailOffset = 0
      return
    }
    if (action === 'surface.last') {
      this.index = this.visibleRecordIndexes().at(-1) ?? Math.max(0, this.records.length - 1)
      this.followTail = true
      this.detailOffset = 0
      return
    }
    if (action === 'surface.half-page-previous') {
      this.move(-Math.max(1, Math.floor(this.listPageRows / 2)))
      return
    }
    if (action === 'surface.half-page-next') {
      this.move(Math.max(1, Math.floor(this.listPageRows / 2)))
      return
    }
    if (action === 'surface.confirm' && this.records[this.index] !== undefined) {
      this.openDetail()
    }
  }

  handlePointer(action: SurfacePointerAction): boolean {
    const region = action.column < this.executionColumnEnd
      ? 'execution'
      : this.detailColumnStart !== undefined && action.column >= this.detailColumnStart
        ? 'detail'
        : undefined
    if (region === undefined) return false
    if (action.kind === 'click') {
      const hit = this.clickHits.find(candidate => (
        candidate.row === action.row
        && action.column >= candidate.columnStart
        && action.column < candidate.columnEnd
      ))
      if (hit?.target.kind === 'tab') {
        return this.activateTab(hit.target.index)
      }
      if (hit?.target.kind !== 'record') return false
      const followsTail = hit.target.index === this.records.length - 1
      const changed = this.index !== hit.target.index
        || this.mode !== 'list'
        || this.followTail !== followsTail
        || this.detailOffset !== 0
      this.index = hit.target.index
      this.mode = 'list'
      this.followTail = followsTail
      this.detailOffset = 0
      return changed
    }
    if (region === 'detail') {
      const previous = this.detailOffset
      this.scrollDetail(action.direction)
      return this.detailOffset !== previous
    }
    const previous = this.index
    if (action.direction < 0 && this.index === 0) void this.loadEarlier()
    else this.move(action.direction)
    return this.index !== previous
  }

  invalidate(): void {}

  render(width: number): string[] {
    const now = Date.now()
    const { metrics, bottleneck } = this.model.measure(now)
    this.clickHits.splice(0)
    this.executionColumnEnd = 0
    this.detailColumnStart = undefined
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
    this.executionColumnEnd = width
    const body = this.renderListRows(width, available, metrics, header.length + 1)
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
      : 'Ledger focus · j/k select · J/K scroll detail · h/l fold · Enter/Tab inspect · Esc chat'
    const footer = [truncateToWidth(this.theme.dim(footerText), width)]
    const available = Math.max(0, height - header.length - footer.length)
    const innerWidth = Math.max(1, width - 3)
    const leftWidth = Math.max(58, Math.min(innerWidth - 42, Math.floor(innerWidth * 0.58)))
    const rightWidth = Math.max(1, innerWidth - leftWidth)
    const record = this.records[this.index]
    if (record === undefined) return this.renderList(width, metrics, bottleneck)

    this.executionColumnEnd = leftWidth
    this.detailColumnStart = leftWidth + 3
    const leftBodyRows = Math.max(0, available - 1)
    const left = [
      this.renderColumnHeader(leftWidth),
      ...this.renderListRows(leftWidth, leftBodyRows, metrics, header.length + 1),
    ]
    const right = this.renderDetailPanel(
      rightWidth,
      available,
      record,
      metrics.get(record.key) ?? { offsetMs: 0, slowest: false },
      true,
      header.length,
      this.detailColumnStart,
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
    this.detailColumnStart = 0
    return this.renderDetailPanel(
      width,
      Math.max(1, this.visibleRows()),
      record,
      metrics.get(record.key) ?? { offsetMs: 0, slowest: false },
      false,
      0,
      0,
    )
  }

  private renderDetailPanel(
    width: number,
    height: number,
    record: TrajectoryRecord,
    metrics: TrajectoryMetrics,
    split: boolean,
    rowOffset: number,
    columnOffset: number,
  ): string[] {
    const tabs = this.renderTabs(width, rowOffset + 2, columnOffset)
    const location = [
      record.turn === undefined ? undefined : `Turn ${String(record.turn)}`,
      record.step === undefined ? undefined : `Step ${String(record.step)}`,
      `seq ${String(record.seq)}`,
    ].filter(value => value !== undefined).join(' · ')
    const header = split ? [
      truncateToWidth(this.theme.bold(this.theme.accent(`DETAIL · ${recordPresentation(record).heading}`)), width),
      truncateToWidth(this.theme.dim(`${kindLabel(record.kind)} · ${location}`), width),
      truncateToWidth(tabs, width),
      this.theme.dim('─'.repeat(Math.max(0, width))),
    ] : [
      truncateToWidth(this.theme.bold(this.theme.accent(`Trajectory · ${recordPresentation(record).heading}`)), width),
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
      this.state.runState !== 'idle' ? 'Live' : 'Idle',
      activeTurn?.title,
      total === undefined ? undefined : formatDuration(total, 'detail'),
      recordCount,
    ].filter(value => value !== undefined).join(' · ')
    const bottleneckMetrics = bottleneck === undefined ? undefined : metrics.get(bottleneck.key)
    const bottleneckLine = bottleneck === undefined || bottleneckMetrics?.durationMs === undefined
      ? 'Bottleneck · no timed operation available yet'
      : `Bottleneck · ${recordPresentation(bottleneck).heading} · ${formatDuration(bottleneckMetrics.durationMs, 'detail')}${
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
    rowOffset: number,
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
    return visible.map((recordIndex, row) => {
      this.clickHits.push({
        row: rowOffset + row,
        columnStart: 0,
        columnEnd: width,
        target: { kind: 'record', index: recordIndex },
      })
      const record = this.records[recordIndex] as TrajectoryRecord
      return this.renderRecord(
        record,
        recordIndex === this.index,
        width,
        metrics.get(record.key) ?? { offsetMs: 0, slowest: false },
      )
    })
  }

  private renderRecord(
    record: TrajectoryRecord,
    selected: boolean,
    width: number,
    metrics: TrajectoryMetrics,
  ): string {
    if (width < 28) {
      const cursor = selected ? this.theme.accent('›') : ' '
      return paintLedgerRow(
        `${cursor} ${kindLabel(record.kind)} ${recordPresentation(record).ledger}`,
        selected,
        width,
        this.theme,
      )
    }
    const branch = record.kind === 'turn'
      ? ''
      : record.kind === 'step'
        ? '  ├─'
        : record.step === undefined
          ? '  ├─'
          : '  │ ├─'
    const glyph = recordGlyph(record, this.theme)
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
    const content = padVisible(recordPresentation(record).ledger, contentWidth)
    const line = `${prefix}${content} ${suffix}`
    return paintLedgerRow(line, selected, width, this.theme)
  }

  private renderTabs(width: number, row: number, columnOffset: number): string {
    let column = 0
    const segments = TABS.map((tab, index) => {
      const segment = index === this.tabIndex
        ? this.theme.bold(this.theme.accent(`[${tab.label}]`))
        : this.theme.dim(` ${tab.label} `)
      const segmentWidth = visibleWidth(segment)
      const columnStart = columnOffset + column
      const columnEnd = columnOffset + Math.min(width, column + segmentWidth)
      if (column < width && columnEnd > columnStart) {
        this.clickHits.push({
          row,
          columnStart,
          columnEnd,
          target: { kind: 'tab', index },
        })
      }
      column += segmentWidth + 1
      return segment
    })
    return segments.join(' ')
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
    this.activateTab(0)
  }

  private selectTab(offset: number): void {
    this.activateTab(this.tabIndex + offset)
  }

  private activateTab(index: number): boolean {
    const next = (index + TABS.length) % TABS.length
    const changed = this.tabIndex !== next || this.mode !== 'detail' || this.detailOffset !== 0
    this.tabIndex = next
    this.mode = 'detail'
    this.followTail = false
    this.detailOffset = 0
    return changed
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
