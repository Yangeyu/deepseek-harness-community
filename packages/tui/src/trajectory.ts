import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiState } from './controller.ts'
import { displayUnknown, sanitizeTerminalText } from './text.ts'
import type { TuiTheme } from './theme.ts'

type TrajectoryKind = 'turn' | 'step' | 'user' | 'request' | 'assistant' | 'tool' | 'context' | 'event'
type TrajectoryStatus = 'pending' | 'completed' | 'warning' | 'failed' | 'info'
type TrajectoryTab = 'summary' | 'payload' | 'result' | 'schema' | 'timing'

const TABS: ReadonlyArray<{ id: TrajectoryTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'payload', label: 'Payload' },
  { id: 'result', label: 'Result' },
  { id: 'schema', label: 'Schema' },
  { id: 'timing', label: 'Timing' },
]

/** One semantic execution record assembled from the durable session event log. */
export interface TrajectoryRecord {
  key: string
  kind: TrajectoryKind
  type: string
  completionType?: string
  seq: number
  completionSeq?: number
  turn?: number
  step?: number
  title: string
  summary: string
  status: TrajectoryStatus
  startedAt: number
  completedAt?: number
  payload?: unknown
  result?: unknown
  schema?: unknown
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numericField(value: unknown, field: string): number | undefined {
  const candidate = recordValue(value)?.[field]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function position(entry: HistoryEntry): Pick<TrajectoryRecord, 'turn' | 'step'> {
  const turn = numericField(entry.event.data, 'turn')
  const step = numericField(entry.event.data, 'step')
  return {
    ...turn === undefined ? {} : { turn },
    ...step === undefined ? {} : { step },
  }
}

function locatedPosition(
  entry: HistoryEntry,
  activeTurn: number | undefined,
  activeStep: number | undefined,
): Pick<TrajectoryRecord, 'turn' | 'step'> {
  const explicit = position(entry)
  const turn = explicit.turn ?? activeTurn
  const step = explicit.step ?? activeStep
  return {
    ...turn === undefined ? {} : { turn },
    ...step === undefined ? {} : { step },
  }
}

function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const item of value) {
    const block = recordValue(item)
    if (block === undefined) continue
    if (typeof block.text === 'string') parts.push(block.text)
    if (Array.isArray(block.content)) {
      const nested = contentText(block.content)
      if (nested !== '') parts.push(nested)
    }
  }
  return parts.join('\n')
}

function messageText(value: unknown): string {
  return contentText(recordValue(value)?.content)
}

function oneLine(value: string, maximum = 140): string {
  const normalized = sanitizeTerminalText(value).replaceAll(/\s+/gu, ' ').trim()
  if (normalized.length <= maximum) return normalized
  return `${normalized.slice(0, Math.max(1, maximum - 1))}…`
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function resultTitle(entry: HistoryEntry | undefined): string | undefined {
  if (entry?.view?.for !== 'result') return undefined
  return entry.view.view.title
}

function callTitle(entry: HistoryEntry): string | undefined {
  if (entry.view?.for !== 'call') return undefined
  return entry.view.view.title
}

function turnStatus(reason: unknown): TrajectoryStatus {
  const kind = recordValue(reason)?.kind
  if (kind === 'completed') return 'completed'
  if (kind === 'error') return 'failed'
  return 'warning'
}

function resultFailed(entry: HistoryEntry): boolean {
  if (entry.event.type !== 'tool/result') return false
  const block = entry.event.data.message.content[0]
  return entry.event.data.error !== undefined || block?.isError === true
}

function toolResult(entry: HistoryEntry): unknown {
  if (entry.event.type !== 'tool/result') return undefined
  const text = messageText(entry.event.data.message)
  if (entry.event.data.error === undefined) return text === '' ? entry.event.data.message.content : text
  return {
    error: entry.event.data.error,
    ...text === '' ? { content: entry.event.data.message.content } : { content: text },
  }
}

function toolSchemaMap(entry: HistoryEntry): Map<string, unknown> | undefined {
  if (entry.event.type !== 'request/header') return undefined
  const schemas = new Map<string, unknown>()
  for (const tool of entry.event.data.header.tools ?? []) schemas.set(tool.name, tool)
  return schemas
}

/** Pair lifecycle boundaries and tool call/results into an ordered diagnostic ledger. */
export function buildTrajectoryRecords(entries: readonly HistoryEntry[]): TrajectoryRecord[] {
  const turnEnds = new Map<number, HistoryEntry>()
  const stepEnds = new Map<string, HistoryEntry>()
  const stepStarts = new Map<string, HistoryEntry>()
  const toolResults = new Map<string, HistoryEntry>()
  for (const entry of entries) {
    const event = entry.event
    if (event.type === 'turn/end') turnEnds.set(event.data.turn, entry)
    if (event.type === 'step/start') stepStarts.set(stepKey(event.data.turn, event.data.step), entry)
    if (event.type === 'step/end') stepEnds.set(stepKey(event.data.turn, event.data.step), entry)
    if (event.type === 'tool/result') toolResults.set(String(event.data.message.source.callId), entry)
  }

  let schemas = new Map<string, unknown>()
  let activeTurn: number | undefined
  let activeStep: number | undefined
  const records: TrajectoryRecord[] = []
  for (const entry of entries) {
    const event = entry.event
    if (event.type === 'turn/start') activeTurn = event.data.turn
    if (event.type === 'step/start') activeStep = event.data.step
    const at = locatedPosition(entry, activeTurn, activeStep)
    const schemaSnapshot = toolSchemaMap(entry)
    if (schemaSnapshot !== undefined) schemas = schemaSnapshot
    switch (event.type) {
      case 'assistant/chunk':
      case 'turn/end':
      case 'step/end':
      case 'tool/result':
        break
      case 'turn/start': {
        const completed = turnEnds.get(event.data.turn)
        const reason = completed?.event.type === 'turn/end' ? completed.event.data.reason : undefined
        const reasonKind = recordValue(reason)?.kind
        records.push({
          key: `turn:${String(event.data.turn)}:${String(event.seq)}`,
          kind: 'turn',
          type: event.type,
          ...completed === undefined ? {} : { completionType: completed.event.type, completionSeq: completed.event.seq },
          seq: event.seq,
          turn: event.data.turn,
          title: `Turn ${String(event.data.turn)}`,
          summary: completed === undefined ? 'Running' : `Finished · ${typeof reasonKind === 'string' ? reasonKind : 'completed'}`,
          status: completed === undefined ? 'pending' : turnStatus(reason),
          startedAt: event.time,
          ...completed === undefined ? {} : { completedAt: completed.event.time, result: reason },
          payload: event.data,
        })
        break
      }
      case 'step/start': {
        const completed = stepEnds.get(stepKey(event.data.turn, event.data.step))
        records.push({
          key: `step:${String(event.data.turn)}:${String(event.data.step)}:${String(event.seq)}`,
          kind: 'step',
          type: event.type,
          ...completed === undefined ? {} : { completionType: completed.event.type, completionSeq: completed.event.seq },
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: `Step ${String(event.data.step)}`,
          summary: completed === undefined ? 'Running' : 'Completed',
          status: completed === undefined ? 'pending' : 'completed',
          startedAt: event.time,
          ...completed === undefined ? {} : { completedAt: completed.event.time, result: completed.event.data },
          payload: event.data,
        })
        break
      }
      case 'user/message': {
        const text = messageText(event.data)
        const source = recordValue(event.data.source)?.kind
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'user',
          type: event.type,
          seq: event.seq,
          ...at,
          title: source === 'user' ? 'User input' : 'Context input',
          summary: oneLine(text === '' ? displayUnknown(event.data.content) : text),
          status: 'info',
          startedAt: event.time,
          payload: event.data,
        })
        break
      }
      case 'assistant/message': {
        const start = stepStarts.get(stepKey(event.data.turn, event.data.step))
        const text = messageText(event.data.message)
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'assistant',
          type: event.type,
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: 'Assistant response',
          summary: oneLine(text === '' ? '(empty response)' : text),
          status: 'completed',
          startedAt: start?.event.time ?? event.time,
          completedAt: event.time,
          payload: { source: event.data.message.source },
          result: {
            content: text === '' ? event.data.message.content : text,
            ...event.data.usage === undefined ? {} : { usage: event.data.usage },
          },
        })
        break
      }
      case 'tool/call': {
        const completed = toolResults.get(String(event.data.callId))
        const displayTitle = resultTitle(completed) ?? callTitle(entry) ?? event.data.name
        const failed = completed === undefined ? false : resultFailed(completed)
        records.push({
          key: `tool:${String(event.data.callId)}:${String(event.seq)}`,
          kind: 'tool',
          type: event.type,
          ...completed === undefined ? {} : { completionType: completed.event.type, completionSeq: completed.event.seq },
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: displayTitle,
          summary: `${event.data.name} · ${completed === undefined ? 'Running' : failed ? 'Failed' : 'Completed'}`,
          status: completed === undefined ? 'pending' : failed ? 'failed' : 'completed',
          startedAt: event.time,
          ...completed === undefined ? {} : { completedAt: completed.event.time, result: toolResult(completed) },
          payload: {
            callId: event.data.callId,
            name: event.data.name,
            arguments: parsedJson(event.data.arguments),
          },
          ...schemas.get(event.data.name) === undefined ? {} : { schema: schemas.get(event.data.name) },
        })
        break
      }
      case 'request/header': {
        const config = event.data.header.config
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'request',
          type: event.type,
          seq: event.seq,
          ...at,
          title: 'Model request',
          summary: `${config.provider}/${config.model}${config.reasoningEffort === undefined ? '' : ` · ${String(config.reasoningEffort)}`}`,
          status: 'info',
          startedAt: event.time,
          payload: event.data.header,
          ...event.data.header.tools === undefined ? {} : { schema: event.data.header.tools },
        })
        break
      }
      case 'request/context':
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'context',
          type: event.type,
          seq: event.seq,
          ...at,
          title: 'Request context',
          summary: `${event.data.provider}/${event.data.model}${event.data.contextWindow === undefined ? '' : ` · ${String(event.data.contextWindow)} context`}`,
          status: 'info',
          startedAt: event.time,
          payload: event.data,
        })
        break
      default: {
        records.push({
          key: `event:${String(event.seq)}`,
          kind: event.type === 'todo/write' ? 'context' : 'event',
          type: event.type,
          seq: event.seq,
          ...at,
          title: event.type,
          summary: oneLine(displayUnknown(event.data)),
          status: 'info',
          startedAt: event.time,
          payload: event.data,
        })
      }
    }
    if (event.type === 'step/end') activeStep = undefined
    if (event.type === 'turn/end') {
      activeStep = undefined
      activeTurn = undefined
    }
  }
  return records
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(Math.max(0, Math.round(milliseconds)))} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  return `${String(minutes)}m ${String(seconds)}s`
}

function tabValue(record: TrajectoryRecord, tab: TrajectoryTab): string[] {
  switch (tab) {
    case 'summary':
      return [
        `Kind: ${record.kind}`,
        `Status: ${record.status}`,
        `Event: ${record.type}${record.completionType === undefined ? '' : ` → ${record.completionType}`}`,
        `Sequence: ${String(record.seq)}${record.completionSeq === undefined ? '' : ` → ${String(record.completionSeq)}`}`,
        ...record.turn === undefined ? [] : [`Turn: ${String(record.turn)}`],
        ...record.step === undefined ? [] : [`Step: ${String(record.step)}`],
        '',
        record.title,
        record.summary,
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
          `Duration: ${formatDuration(Math.max(0, end - record.startedAt))}`,
        ],
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
    case 'context': return 'CONTEXT'
    case 'event': return 'EVENT'
  }
}

/** Full-screen, keyboard-first execution ledger and event detail surface. */
export class TrajectoryView implements Component {
  private state: Readonly<TuiState>
  private records: TrajectoryRecord[]
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
    this.index = Math.max(0, this.records.length - 1)
  }

  /** Rebuild from the latest live event window while preserving the selected semantic record. */
  setState(state: Readonly<TuiState>): void {
    const sessionChanged = state.sessionId !== this.state.sessionId
    const selectedKey = this.records[this.index]?.key
    this.state = state
    this.records = buildTrajectoryRecords(state.events)
    if (sessionChanged) {
      this.mode = 'list'
      this.followTail = true
      this.tabIndex = 0
      this.detailOffset = 0
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
      if (matchesKey(data, Key.up)) this.scrollDetail(-1)
      if (matchesKey(data, Key.down)) this.scrollDetail(1)
      if (matchesKey(data, Key.pageUp)) this.scrollDetail(-this.detailPageRows)
      if (matchesKey(data, Key.pageDown)) this.scrollDetail(this.detailPageRows)
      return
    }
    if (matchesKey(data, Key.escape)) {
      this.onCancel()
      return
    }
    if (matchesKey(data, Key.up)) {
      if (this.index === 0) void this.loadEarlier()
      else this.move(-1)
      return
    }
    if (matchesKey(data, Key.down)) {
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
    if (matchesKey(data, Key.enter) && this.records[this.index] !== undefined) {
      this.mode = 'detail'
      this.followTail = false
      this.tabIndex = 0
      this.detailOffset = 0
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.mode === 'detail' ? this.renderDetail(width) : this.renderList(width)
  }

  private renderList(width: number): string[] {
    const height = Math.max(1, this.visibleRows())
    const header = [
      truncateToWidth(this.theme.bold(this.theme.accent('Trajectory')), width),
      truncateToWidth(this.theme.dim([
        this.state.sessionId === undefined ? 'No session' : String(this.state.sessionId),
        this.state.running ? 'Live' : 'Idle',
        `${String(this.records.length)} records`,
        ...this.state.historyHasMore ? ['earlier history available'] : [],
      ].join(' · ')), width),
      '',
    ]
    const footerText = this.loadingEarlier
      ? 'Loading earlier history…'
      : this.loadError === undefined
        ? '↑/↓ select · Enter details · PageUp/PageDown page · Esc chat'
        : `History load failed: ${this.loadError}`
    const footer = [truncateToWidth(
      this.loadError === undefined ? this.theme.dim(footerText) : this.theme.warning(footerText),
      width,
    )]
    const available = Math.max(0, height - header.length - footer.length)
    this.listPageRows = Math.max(1, available)
    const maximumStart = Math.max(0, this.records.length - available)
    const start = Math.max(0, Math.min(maximumStart, this.index - Math.floor(available / 2)))
    const visible = this.records.slice(start, start + available)
    const body = visible.length === 0 && available > 0
      ? [this.theme.dim('No execution records yet. Events will appear here while the session runs.')]
      : visible.map((record, offset) => this.renderRecord(record, start + offset === this.index, width))
    return this.fit([...header, ...body, ...Array<string>(Math.max(0, available - body.length)).fill(''), ...footer], height)
  }

  private renderDetail(width: number): string[] {
    const height = Math.max(1, this.visibleRows())
    const record = this.records[this.index]
    if (record === undefined) {
      this.mode = 'list'
      return this.renderList(width)
    }
    const tabs = TABS.map((tab, index) => index === this.tabIndex
      ? this.theme.bold(this.theme.accent(`[${tab.label}]`))
      : this.theme.dim(` ${tab.label} `)).join(' ')
    const location = [
      record.turn === undefined ? undefined : `Turn ${String(record.turn)}`,
      record.step === undefined ? undefined : `Step ${String(record.step)}`,
      `seq ${String(record.seq)}`,
    ].filter(value => value !== undefined).join(' · ')
    const header = [
      truncateToWidth(this.theme.bold(this.theme.accent(`Trajectory · ${record.title}`)), width),
      truncateToWidth(this.theme.dim(`${kindLabel(record.kind)} · ${location}`), width),
      truncateToWidth(tabs, width),
      '',
    ]
    const available = Math.max(0, height - header.length - 1)
    this.detailPageRows = Math.max(1, available)
    const tab = TABS[this.tabIndex]?.id ?? 'summary'
    const content = wrapped(tabValue(record, tab), width)
    this.detailMaxOffset = Math.max(0, content.length - available)
    this.detailOffset = Math.max(0, Math.min(this.detailMaxOffset, this.detailOffset))
    const body = content.slice(this.detailOffset, this.detailOffset + available)
    const range = content.length <= available
      ? ''
      : ` · ${String(this.detailOffset + 1)}-${String(Math.min(content.length, this.detailOffset + available))}/${String(content.length)}`
    const footer = [truncateToWidth(this.theme.dim(
      `Tab/←/→ section · ↑/↓ scroll · Esc events${range}`,
    ), width)]
    return this.fit([...header, ...body, ...Array<string>(Math.max(0, available - body.length)).fill(''), ...footer], height)
  }

  private renderRecord(record: TrajectoryRecord, selected: boolean, width: number): string {
    const indent = record.kind === 'turn' ? '' : record.kind === 'step' ? '  ' : record.step === undefined ? '  ' : '    '
    const glyph = record.status === 'pending'
      ? this.theme.warning('○')
      : record.status === 'warning'
        ? this.theme.warning('!')
      : record.status === 'failed'
        ? this.theme.error('×')
        : record.status === 'completed'
          ? this.theme.success('●')
          : this.theme.dim('·')
    const cursor = selected ? this.theme.accent('›') : ' '
    const label = kindLabel(record.kind).padEnd(9)
    const duration = record.completedAt === undefined
      ? ''
      : ` · ${formatDuration(Math.max(0, record.completedAt - record.startedAt))}`
    const plain = `${cursor} ${indent}${glyph} ${label} ${record.summary}${duration}`
    return truncateToWidth(selected ? this.theme.bold(plain) : plain, width, '…')
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(this.records.length - 1, this.index + offset))
    this.followTail = this.index === this.records.length - 1
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
